require('dotenv').config();
const express = require('express');
const TelegramBot = require('node-telegram-bot-api');
const mongoose = require('mongoose');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 10000;

// Проверка переменных окружения
const required = ['BOT_TOKEN', 'MONGODB_URI', 'VIP_CHANNEL_ID', 'WALLET_ADDRESS'];
for (const key of required) {
  if (!process.env[key]) {
    console.error(`❌ Missing ${key}`);
    process.exit(1);
  }
}

// Подключение к MongoDB
mongoose.connect(process.env.MONGODB_URI)
  .then(() => console.log('✅ MongoDB connected'))
  .catch(err => {
    console.error('❌ MongoDB error:', err.message);
    setTimeout(() => process.exit(1), 5000);
  });

// Модель пользователя
const userSchema = new mongoose.Schema({
  userId: { type: Number, required: true, unique: true },
  username: String,
  firstName: String,
  subscription: { type: String, default: 'none' },
  expiresAt: Date,
  pendingPayment: { plan: String, amount: Number }
});

const User = mongoose.model('User', userSchema);

// Telegram Bot — ТОЛЬКО POLLING
const bot = new TelegramBot(process.env.BOT_TOKEN, { polling: true });

// Команда /start
bot.onText(/\/start/, async (msg) => {
  const chatId = msg.chat.id;
  await User.findOneAndUpdate(
    { userId: chatId },
    { userId: chatId, username: msg.chat.username, firstName: msg.chat.first_name },
    { upsert: true }
  );
  await bot.sendMessage(chatId, `🚀 Welcome to FXWave VIP Access, ${msg.chat.first_name}!\n\nChoose your subscription plan:`, {
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
  });
});

// Обработка кнопок
bot.on('callback_query', async (callbackQuery) => {
  const chatId = callbackQuery.message.chat.id;
  const data = callbackQuery.data;

  try {
    if (data.startsWith('subscribe_')) {
      const plan = data.split('_')[1];
      const prices = { '1month': 24, '3months': 55 };
      const amount = prices[plan];
      const wallet = process.env.WALLET_ADDRESS;

      await bot.sendMessage(chatId,
        `💳 <b>Payment Instructions for ${plan.toUpperCase()}</b>\n\n` +
        `📍 Send exactly <b>${amount} USDT</b> (TRC20) to:\n<code>${wallet}</code>\n\n` +
        `⚠️ <b>Important:</b>\n` +
        `• Send only USDT (TRC20)\n` +
        `• Send exact amount: <b>${amount} USDT</b>\n` +
        `• Network: <b>TRON (TRC20)</b>\n` +
        `• After payment, forward the transaction hash to this bot\n\n` +
        `Once verified, you'll get VIP access automatically!`,
        {
          parse_mode: 'HTML',
          reply_markup: {
            inline_keyboard: [[{ text: '🔙 Back to Plans', callback_data: 'back_to_plans' }]]
          }
        }
      );

      await User.findOneAndUpdate({ userId: chatId }, { $set: { pendingPayment: { plan, amount } } });
    } else if (data === 'my_subscription') {
      const user = await User.findOne({ userId: chatId });
      if (!user || user.subscription === 'none') {
        await bot.sendMessage(chatId,
          `📊 <b>Your Subscription Status</b>\n\n❌ No active subscription\nChoose a plan to get VIP access!`,
          { parse_mode: 'HTML', reply_markup: { inline_keyboard: [[{ text: '🎫 View Plans', callback_data: 'back_to_plans' }]] } }
        );
      } else {
        const days = Math.ceil((user.expiresAt - new Date()) / (1000 * 60 * 60 * 24));
        await bot.sendMessage(chatId,
          `📊 <b>Your Subscription Status</b>\n\n` +
          `✅ Plan: <b>${user.subscription.toUpperCase()}</b>\n` +
          `⏰ Expires in: <b>${days} days</b>\n` +
          `📅 Renewal: <b>${user.expiresAt.toLocaleDateString()}</b>`,
          { parse_mode: 'HTML', reply_markup: { inline_keyboard: [[{ text: '🔄 Renew Subscription', callback_data: 'back_to_plans' }]] } }
        );
      }
    } else if (data === 'how_to_pay') {
      await bot.sendMessage(chatId,
        `💡 <b>How to Pay with USDT</b>\n\n` +
        `1. Open your crypto wallet (Trust Wallet, Binance, etc.)\n` +
        `2. Select USDT and make sure to choose <b>TRON (TRC20)</b> network\n` +
        `3. Send exact amount from the subscription plan\n` +
        `4. Copy the <b>Transaction Hash (TXID)</b> after sending\n` +
        `5. Forward the transaction hash to this bot\n\n` +
        `⏳ Verification usually takes 5-15 minutes`,
        { parse_mode: 'HTML', reply_markup: { inline_keyboard: [[{ text: '🎫 View Plans', callback_data: 'back_to_plans' }]] } }
      );
    } else if (data === 'back_to_plans') {
      await bot.deleteMessage(chatId, callbackQuery.message.message_id);
      bot.emit('message', { chat: { id: chatId }, text: '/start' });
    }
  } catch (error) {
    console.error('Callback error:', error);
    await bot.sendMessage(chatId, '❌ An error occurred. Please try again.', { parse_mode: 'HTML' });
  }
});

// Обработка транзакций
bot.on('message', async (msg) => {
  if (!msg.text || msg.text.startsWith('/')) return;
  const chatId = msg.chat.id;
  const tx = msg.text.trim();
  if (tx.length === 64 && /^[a-fA-F0-9]+$/.test(tx)) {
    await bot.sendMessage(chatId, '⏳ Verifying payment...', { parse_mode: 'HTML' });

    setTimeout(async () => {
      try {
        const user = await User.findOne({ userId: chatId });
        if (user && user.pendingPayment) {
          const { plan } = user.pendingPayment;
          const expiresAt = new Date();
          expiresAt.setMonth(expiresAt.getMonth() + (plan === '1month' ? 1 : 3));

          await User.findOneAndUpdate(
            { userId: chatId },
            {
              subscription: plan,
              expiresAt,
              $unset: { pendingPayment: 1 },
              $push: {
                transactions: {
                  hash: tx,
                  amount: user.pendingPayment.amount,
                  status: 'completed',
                  timestamp: new Date()
                }
              }
            }
          );

          // Попытка добавить в канал
          let added = false;
          try {
            await bot.addChatMember(process.env.VIP_CHANNEL_ID, chatId);
            added = true;
          } catch (e) {
            if (e.response?.body?.description?.includes('USER_ALREADY_PARTICIPANT')) {
              added = true;
            }
          }

          if (added) {
            await bot.sendMessage(chatId,
              `✅ <b>Payment Verified!</b>\n\nYour <b>${plan}</b> VIP subscription has been activated!\n\n🎉 <b>You have been added to the VIP channel!</b>`,
              { parse_mode: 'HTML' }
            );
          } else {
            await bot.sendMessage(chatId,
              `✅ <b>Payment Verified!</b>\n\nYour <b>${plan}</b> VIP subscription has been activated!\n\n⚠️ <b>Could not add you to VIP channel.</b> Please contact support.`,
              { parse_mode: 'HTML' }
            );
          }
        }
      } catch (error) {
        console.error('Error activating subscription:', error);
        await bot.sendMessage(chatId, '❌ Error activating subscription. Please contact support.', { parse_mode: 'HTML' });
      }
    }, 10000);
  }
});

// Команда /testchannel — для диагностики
bot.onText(/\/testchannel/, async (msg) => {
  const chatId = msg.chat.id;
  try {
    const chat = await bot.getChat(process.env.VIP_CHANNEL_ID);
    await bot.sendMessage(chatId, `✅ <b>Channel found:</b> ${chat.title}`, { parse_mode: 'HTML' });

    const admins = await bot.getChatAdministrators(process.env.VIP_CHANNEL_ID);
    const botInfo = await bot.getMe();
    const isBotAdmin = admins.some(admin => admin.user.id === botInfo.id && admin.can_invite_users);

    if (isBotAdmin) {
      await bot.sendMessage(chatId, `✅ <b>Bot is administrator</b> with invite rights.`, { parse_mode: 'HTML' });
    } else {
      await bot.sendMessage(chatId, `❌ <b>Bot is NOT administrator</b> or missing "Add members" permission.`, { parse_mode: 'HTML' });
    }

    try {
      await bot.addChatMember(process.env.VIP_CHANNEL_ID, chatId);
      await bot.sendMessage(chatId, `✅ <b>Test: successfully added to VIP channel.</b>`, { parse_mode: 'HTML' });
    } catch (e) {
      await bot.sendMessage(chatId, `❌ <b>Test: failed to add to VIP channel.</b>`, { parse_mode: 'HTML' });
    }
  } catch (error) {
    await bot.sendMessage(chatId, `❌ <b>Test error:</b> ${error.message}`, { parse_mode: 'HTML' });
  }
});

// Web server
app.use(express.static('public'));
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});
app.get('/health', (req, res) => {
  res.json({ status: 'OK', db: mongoose.connection.readyState === 1 ? 'connected' : 'disconnected' });
});

// =============== 🌐 KEEP-ALIVE FOR RENDER (FREE TIER) ===============
if (process.env.RENDER_EXTERNAL_URL) {
  const url = process.env.RENDER_EXTERNAL_URL;
  setInterval(async () => {
    try {
      const res = await fetch(`${url}/health`);
      console.log(`✅ Keep-alive ping: ${res.status}`);
    } catch (err) {
      console.log('⚠️ Keep-alive error:', err.message);
    }
  }, 14 * 60 * 1000); // каждые 14 минут
}

// Запуск сервера
app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
});

// Обработка ошибок
process.on('unhandledRejection', (reason) => {
  console.error('❌ Unhandled Rejection:', reason);
});
process.on('uncaughtException', (error) => {
  console.error('❌ Uncaught Exception:', error);
  
  // Удаление по истечении срока (раз в час)
setInterval(async () => {
  const expired = await User.find({
    expiresAt: { $lt: new Date() },
    subscription: { $ne: 'none' }
  });

  for (const user of expired) {
    try {
      // Удаляем из канала (работает всегда, если бот — админ)
      await bot.banChatMember(process.env.VIP_CHANNEL_ID, user.userId);
      await bot.unbanChatMember(process.env.VIP_CHANNEL_ID, user.userId);
      
      // Сбрасываем подписку
      user.subscription = 'none';
      await user.save();

      // Уведомляем
      await bot.sendMessage(user.userId, "❌ Your VIP subscription has expired.");
    } catch (e) {
      console.log("Failed to remove user", user.userId);
    }
  }
}, 60 * 60 * 1000); // каждые 60 минут

});
