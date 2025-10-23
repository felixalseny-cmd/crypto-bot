require('dotenv').config();
const express = require('express');
const TelegramBot = require('node-telegram-bot-api');
const mongoose = require('mongoose');
const path = require('path');
const cron = require('cron');

const app = express();
const PORT = process.env.PORT || 3000;

// ==================== 🔍 ПРОВЕРКА ПЕРЕМЕННЫХ ОКРУЖЕНИЯ ====================
console.log('🔧 Starting application...');
console.log('📁 Current directory:', __dirname);

const requiredEnvVars = ['BOT_TOKEN', 'MONGODB_URI', 'VIP_CHANNEL_ID', 'WALLET_ADDRESS'];
requiredEnvVars.forEach(varName => {
  if (!process.env[varName]) {
    console.error(`❌ Missing environment variable: ${varName}`);
    process.exit(1);
  }
  console.log(`✅ ${varName}: ${varName === 'BOT_TOKEN' ? '***' + process.env[varName].slice(-4) : 'Set'}`);
});

console.log('✅ All environment variables loaded');

// ==================== 🗄️ ПОДКЛЮЧЕНИЕ К MONGODB ====================
console.log('🔗 Connecting to MongoDB...');
mongoose.connect(process.env.MONGODB_URI)
  .then(() => console.log('✅ Connected to MongoDB'))
  .catch(err => {
    console.error('❌ MongoDB connection error:', err);
    process.exit(1);
  });

// ==================== 👤 МОДЕЛЬ ПОЛЬЗОВАТЕЛЯ ====================
const userSchema = new mongoose.Schema({
  userId: { type: Number, required: true, unique: true },
  username: String,
  firstName: String,
  subscription: {
    type: String,
    enum: ['none', '1month', '3months'],
    default: 'none'
  },
  expiresAt: Date,
  joinedAt: { type: Date, default: Date.now },
  transactions: [{
    hash: String,
    amount: Number,
    status: { type: String, default: 'pending' },
    timestamp: { type: Date, default: Date.now }
  }],
  pendingPayment: {
    plan: String,
    amount: Number,
    timestamp: Date
  },
  inVipChannel: { type: Boolean, default: false }
});

const User = mongoose.model('User', userSchema);

// ==================== 🤖 ИНИЦИАЛИЗАЦИЯ TELEGRAM БОТА ====================
console.log('🤖 Initializing Telegram Bot...');
const bot = new TelegramBot(process.env.BOT_TOKEN, { polling: true });

bot.getMe().then(botInfo => {
  console.log(`✅ Telegram Bot started: @${botInfo.username}`);
}).catch(err => {
  console.error('❌ Telegram Bot failed:', err);
  process.exit(1);
});

// ==================== 🔄 CRON ДЛЯ ПРОВЕРКИ ПРОСРОЧЕННЫХ ПОДПИСОК ====================
console.log('⏰ Starting subscription expiration checker...');

const checkExpiredSubscriptions = async () => {
  console.log('🔍 Checking for expired subscriptions...');
  try {
    const expiredUsers = await User.find({
      expiresAt: { $lt: new Date() },
      subscription: { $ne: 'none' }
    });

    console.log(`📊 Found ${expiredUsers.length} expired subscriptions`);

    for (const user of expiredUsers) {
      try {
        console.log(`🚫 Removing user ${user.userId} from VIP channel (subscription expired)`);
        
        // Пытаемся удалить пользователя из канала
        try {
          await bot.banChatMember(process.env.VIP_CHANNEL_ID, user.userId);
          // Сразу разбаниваем, чтобы пользователь мог снова подписаться
          await bot.unbanChatMember(process.env.VIP_CHANNEL_ID, user.userId);
          console.log(`✅ Successfully removed user ${user.userId} from VIP channel`);
        } catch (banError) {
          console.log(`⚠️ Could not remove user ${user.userId} from channel:`, banError.message);
        }

        // Обновляем статус пользователя
        user.subscription = 'none';
        user.inVipChannel = false;
        await user.save();

        // Уведомляем пользователя
        try {
          await bot.sendMessage(user.userId,
            `❌ Your VIP subscription has expired.\n\nTo continue receiving premium signals, please renew your subscription.`,
            { 
              parse_mode: 'Markdown',
              reply_markup: {
                inline_keyboard: [
                  [{ text: '🔄 Renew Subscription', callback_data: 'back_to_plans' }]
                ]
              }
            }
          );
        } catch (msgError) {
          console.log(`⚠️ Could not send expiration message to user ${user.userId}`);
        }

      } catch (error) {
        console.error(`❌ Error processing expired subscription for user ${user.userId}:`, error);
      }
    }
  } catch (error) {
    console.error('❌ Error in subscription expiration check:', error);
  }
};

// Запускаем проверку каждые 6 часов
const expirationJob = new cron.CronJob('0 */6 * * *', checkExpiredSubscriptions);
expirationJob.start();

// Также запускаем немедленно при старте
setTimeout(checkExpiredSubscriptions, 10000);

// ==================== 🎯 КОМАНДА /START ====================
bot.onText(/\/start/, async (msg) => {
  const chatId = msg.chat.id;
  
  await User.findOneAndUpdate(
    { userId: chatId },
    {
      userId: chatId,
      username: msg.chat.username,
      firstName: msg.chat.first_name
    },
    { upsert: true }
  );

  const welcomeMessage = `🚀 Welcome to FXWave VIP Access, ${msg.chat.first_name}!\n\nChoose your subscription plan:`;

  const options = {
    reply_markup: {
      inline_keyboard: [
        [
          { text: '📅 1 Month - 24 USDT', callback_data: 'subscribe_1month' },
          { text: '⭐ 3 Months - 55 USDT', callback_data: 'subscribe_3months' }
        ],
        [
          { text: 'ℹ️ My Subscription', callback_data: 'my_subscription' },
          { text: '💳 How to Pay', callback_data: 'how_to_pay' }
        ]
      ]
    }
  };

  await bot.sendMessage(chatId, welcomeMessage, options);
});

// ==================== 🔘 ОБРАБОТКА CALLBACK КНОПОК ====================
bot.on('callback_query', async (callbackQuery) => {
  const message = callbackQuery.message;
  const data = callbackQuery.data;
  const chatId = message.chat.id;

  try {
    if (data.startsWith('subscribe_')) {
      const plan = data.split('_')[1];
      await sendPaymentInstructions(chatId, plan);
    } else if (data === 'my_subscription') {
      await showUserSubscription(chatId);
    } else if (data === 'how_to_pay') {
      await sendHowToPay(chatId);
    } else if (data === 'back_to_plans') {
      await bot.deleteMessage(chatId, message.message_id);
      bot.emit('message', { ...message, text: '/start' });
    }
  } catch (error) {
    console.error('Callback error:', error);
    await bot.sendMessage(chatId, '❌ An error occurred. Please try again.');
  }
});

// ==================== 💳 ФУНКЦИЯ ОТПРАВКИ ИНСТРУКЦИЙ ПО ОПЛАТЕ ====================
async function sendPaymentInstructions(chatId, plan) {
  const prices = { '1month': 24, '3months': 55 };
  const amount = prices[plan];
  const walletAddress = process.env.WALLET_ADDRESS;

  const message = `💳 *Payment Instructions for ${plan.toUpperCase()}*\n\n📍 Send exactly *${amount} USDT* (TRC20) to:\n\`${walletAddress}\`\n\n⚠️ *Important:*\n• Send only USDT (TRC20)\n• Send exact amount: *${amount} USDT*\n• Network: *TRON (TRC20)*\n• After payment, forward the transaction hash to this bot\n\nOnce verified, you'll get VIP access automatically!`;

  await bot.sendMessage(chatId, message, { 
    parse_mode: 'Markdown',
    reply_markup: {
      inline_keyboard: [
        [{ text: '🔙 Back to Plans', callback_data: 'back_to_plans' }]
      ]
    }
  });

  await User.findOneAndUpdate(
    { userId: chatId },
    { 
      $set: { 
        pendingPayment: { plan, amount, timestamp: new Date() }
      }
    }
  );
}

// ==================== 📊 ПОКАЗАТЬ ИНФОРМАЦИЮ О ПОДПИСКЕ ====================
async function showUserSubscription(chatId) {
  const user = await User.findOne({ userId: chatId });
  
  if (!user || user.subscription === 'none') {
    await bot.sendMessage(chatId, 
      `📊 *Your Subscription Status*\n\n❌ No active subscription\nChoose a plan to get VIP access!`,
      { 
        parse_mode: 'Markdown',
        reply_markup: {
          inline_keyboard: [
            [{ text: '🎫 View Plans', callback_data: 'back_to_plans' }]
          ]
        }
      }
    );
    return;
  }

  const remainingTime = Math.ceil((user.expiresAt - new Date()) / (1000 * 60 * 60 * 24));
  
  await bot.sendMessage(chatId,
    `📊 *Your Subscription Status*\n\n✅ Plan: *${user.subscription.toUpperCase()}*\n⏰ Expires in: *${remainingTime} days*\n📅 Renewal: *${user.expiresAt.toLocaleDateString()}*\n🎯 VIP Access: *${user.inVipChannel ? 'Active' : 'Pending'}*`,
    { 
      parse_mode: 'Markdown',
      reply_markup: {
        inline_keyboard: [
          [{ text: '🔄 Renew Subscription', callback_data: 'back_to_plans' }]
        ]
      }
    }
  );
}

// ==================== 💡 ИНСТРУКЦИЯ КАК ОПЛАТИТЬ ====================
async function sendHowToPay(chatId) {
  const message = `💡 *How to Pay with USDT*\n\n1. Open your crypto wallet (Trust Wallet, Binance, etc.)\n2. Select USDT and make sure to choose *TRON (TRC20)* network\n3. Send exact amount from the subscription plan\n4. Copy the *Transaction Hash (TXID)* after sending\n5. Forward the transaction hash to this bot\n\n⏳ Verification usually takes 5-15 minutes`;

  await bot.sendMessage(chatId, message, { 
    parse_mode: 'Markdown',
    reply_markup: {
      inline_keyboard: [
        [{ text: '🎫 View Subscription Plans', callback_data: 'back_to_plans' }]
      ]
    }
  );
}

// ==================== 🎯 ФУНКЦИЯ ДОБАВЛЕНИЯ В VIP КАНАЛ ====================
async function addToVipChannel(chatId, plan) {
  try {
    console.log(`🔄 Adding user ${chatId} to VIP channel...`);
    
    // Пытаемся добавить пользователя в канал
    await bot.addChatMember(process.env.VIP_CHANNEL_ID, chatId);
    
    console.log(`✅ Successfully added user ${chatId} to VIP channel`);
    
    // Обновляем статус в базе данных
    await User.findOneAndUpdate(
      { userId: chatId },
      { 
        inVipChannel: true,
        subscription: plan
      }
    );
    
    return true;
  } catch (error) {
    console.error(`❌ Failed to add user ${chatId} to VIP channel:`, error.message);
    
    // Если пользователь уже в канале, всё равно отмечаем как успех
    if (error.response && error.response.body && 
        error.response.body.description && 
        error.response.body.description.includes('USER_ALREADY_PARTICIPANT')) {
      console.log(`ℹ️ User ${chatId} is already in VIP channel`);
      await User.findOneAndUpdate(
        { userId: chatId },
        { 
          inVipChannel: true,
          subscription: plan
        }
      );
      return true;
    }
    
    return false;
  }
}

// ==================== 📨 ОБРАБОТКА ТРАНЗАКЦИЙ ====================
bot.on('message', async (msg) => {
  if (msg.text && msg.text.startsWith('/')) return;
  
  const chatId = msg.chat.id;
  
  if (msg.text && msg.text.length === 64 && /^[a-fA-F0-9]+$/.test(msg.text)) {
    await bot.sendMessage(chatId, 
      `⏳ Transaction received! Verifying hash: ${msg.text.substring(0, 12)}...\n\nThis may take a few minutes.`,
      { parse_mode: 'Markdown' }
    );
    
    setTimeout(async () => {
      try {
        const user = await User.findOne({ userId: chatId });
        if (user && user.pendingPayment) {
          const { plan } = user.pendingPayment;
          const expiresAt = new Date();
          expiresAt.setMonth(expiresAt.getMonth() + (plan === '1month' ? 1 : 3));
          
          // Обновляем подписку пользователя
          await User.findOneAndUpdate(
            { userId: chatId },
            {
              subscription: plan,
              expiresAt,
              $unset: { pendingPayment: 1 },
              $push: {
                transactions: {
                  hash: msg.text,
                  amount: user.pendingPayment.amount,
                  status: 'completed',
                  timestamp: new Date()
                }
              }
            }
          );

          // Добавляем пользователя в VIP канал
          const addedToChannel = await addToVipChannel(chatId, plan);
          
          if (addedToChannel) {
            await bot.sendMessage(chatId,
              `✅ *Payment Verified!*\n\nYour ${plan} VIP subscription has been activated!\n\n🎉 You now have access to the private VIP channel with premium trading signals.`,
              { parse_mode: 'Markdown' }
            );
          } else {
            await bot.sendMessage(chatId,
              `✅ *Payment Verified!*\n\nYour ${plan} VIP subscription has been activated!\n\n⚠️ Could not automatically add you to VIP channel. Please contact support.`,
              { parse_mode: 'Markdown' }
            );
          }
        }
      } catch (error) {
        console.error('Error activating subscription:', error);
        await bot.sendMessage(chatId, '❌ Error activating subscription. Please contact support.');
      }
    }, 10000);
  }
});

// ==================== 🌐 WEB ИНТЕРФЕЙС ====================
app.use(express.json());
app.use(express.static('public'));

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.get('/health', (req, res) => {
  res.json({ 
    status: 'OK', 
    service: 'FXWave Crypto Bot',
    timestamp: new Date().toISOString(),
    features: ['telegram_bot', 'vip_channel_management', 'subscription_tracking']
  });
});

// ==================== 🚀 ЗАПУСК СЕРВЕРА ====================
app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
  console.log(`🌐 Web interface available`);
  console.log(`⏰ Subscription expiration checker active`);
  console.log('✅ FXWave Crypto Bot with VIP channel management is ready!');
});

// ==================== 🔄 ОБРАБОТКА ОШИБОК ====================
process.on('unhandledRejection', (reason, promise) => {
  console.error('❌ Unhandled Rejection at:', promise, 'reason:', reason);
});

process.on('uncaughtException', (error) => {
  console.error('❌ Uncaught Exception:', error);
});
