require('dotenv').config();
const express = require('express');
const TelegramBot = require('node-telegram-bot-api');
const mongoose = require('mongoose');
const QRCode = require('qrcode');
const path = require('path');
const crypto = require('crypto');

const app = express();
const PORT = process.env.PORT || 10000;

// 🔧 КОНФИГУРАЦИЯ
const CONFIG = {
  PRICES: {
    USDT: { '1month': 24, '3months': 55 },
    TON: { '1month': 11, '3months': 25 }
  },
  PAYMENT_TIMEOUT: 10000,
  CLEANUP_INTERVAL: 30 * 60 * 1000,
  KEEP_ALIVE_INTERVAL: 10 * 60 * 1000,
  TX_HASH_LENGTH: 64,
  MAX_RETRIES: 3,
  RETRY_DELAY: 2000
};

// 🔐 ПРОВЕРКА ПЕРЕМЕННЫХ ОКРУЖЕНИЯ
const validateEnvironment = () => {
  console.log('🔍 Checking environment variables...');
  
  const required = ['BOT_TOKEN', 'MONGODB_URI', 'VIP_CHANNEL_ID'];
  const walletRequired = ['USDT_WALLET_ADDRESS', 'TON_WALLET_ADDRESS'];
  
  let hasErrors = false;
  
  for (const key of required) {
    if (!process.env[key]) {
      console.error(`❌ Missing required environment variable: ${key}`);
      hasErrors = true;
    } else {
      console.log(`✅ ${key}: ✓`);
    }
  }
  
  for (const key of walletRequired) {
    if (!process.env[key]) {
      console.warn(`⚠️ Missing wallet address: ${key}`);
    } else {
      console.log(`✅ ${key}: ✓`);
    }
  }
  
  if (hasErrors) {
    console.error('🚨 Critical environment variables missing! Shutting down...');
    process.exit(1);
  }
  
  console.log('🎉 Environment validation PASSED!');
};

validateEnvironment();

// 🗄️ ПОДКЛЮЧЕНИЕ К MONGODB
const connectDB = async (retryCount = 0) => {
  try {
    console.log(`🔄 Connecting to MongoDB... (Attempt ${retryCount + 1})`);
    
    await mongoose.connect(process.env.MONGODB_URI, {
      serverSelectionTimeoutMS: 10000,
      socketTimeoutMS: 45000,
      maxPoolSize: 10,
    });
    
    console.log('🎉 MongoDB connected successfully!');
    return true;
  } catch (error) {
    console.error(`❌ MongoDB connection failed (Attempt ${retryCount + 1}):`, error.message);
    
    if (retryCount < CONFIG.MAX_RETRIES - 1) {
      console.log(`🔄 Retrying in ${CONFIG.RETRY_DELAY / 1000} seconds...`);
      await new Promise(resolve => setTimeout(resolve, CONFIG.RETRY_DELAY));
      return connectDB(retryCount + 1);
    } else {
      console.error('🚨 Maximum retry attempts reached. Shutting down...');
      process.exit(1);
    }
  }
};

mongoose.connection.on('disconnected', () => {
  console.warn('⚠️ MongoDB disconnected! Attempting to reconnect...');
  setTimeout(() => connectDB(), 5000);
});

mongoose.connection.on('error', (err) => {
  console.error('❌ MongoDB error:', err);
});

// 👤 МОДЕЛЬ ПОЛЬЗОВАТЕЛЯ
const userSchema = new mongoose.Schema({
  userId: { 
    type: Number, 
    required: true, 
    unique: true, 
    index: true 
  },
  username: String,
  firstName: String,
  subscription: { 
    type: String, 
    default: 'none', 
    enum: ['none', '1month', '3months'] 
  },
  expiresAt: { 
    type: Date, 
    index: true 
  },
  pendingPayment: {
    plan: String,
    amount: Number,
    currency: String,
    paymentId: String,
    createdAt: { 
      type: Date, 
      default: Date.now
    }
  },
  transactions: [{
    hash: String,
    amount: Number,
    currency: String,
    status: { 
      type: String, 
      default: 'pending', 
      enum: ['pending', 'completed', 'failed', 'verified'] 
    },
    timestamp: { 
      type: Date, 
      default: Date.now 
    },
    verified: { 
      type: Boolean, 
      default: false 
    },
    paymentId: String
  }],
  lastActivity: { 
    type: Date, 
    default: Date.now
  },
  joinDate: { 
    type: Date, 
    default: Date.now 
  }
}, {
  timestamps: true
});

userSchema.index({ 'transactions.hash': 1 });
userSchema.index({ expiresAt: 1, subscription: 1 });

const User = mongoose.model('User', userSchema);

// 🤖 TELEGRAM BOT
const bot = new TelegramBot(process.env.BOT_TOKEN, {
  polling: {
    interval: 300,
    autoStart: true,
    params: {
      timeout: 10
    }
  },
  request: {
    timeout: 15000
  }
});

// 🛠️ УТИЛИТЫ
const logger = (event, userId, details = {}) => {
  const timestamp = new Date().toISOString();
  console.log(`📊 [${timestamp}] ${event} - User: ${userId}`, details);
};

const validateTxHash = (hash) => {
  return hash && 
         hash.length === CONFIG.TX_HASH_LENGTH && 
         /^[a-fA-F0-9]+$/.test(hash);
};

const generatePaymentId = () => {
  return `pay_${crypto.randomBytes(8).toString('hex')}`;
};

const calculateExpiry = (plan) => {
  const expiry = new Date();
  const months = plan === '1month' ? 1 : 3;
  expiry.setMonth(expiry.getMonth() + months);
  return expiry;
};

const retryOperation = async (operation, operationName, maxRetries = 3) => {
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      return await operation();
    } catch (error) {
      console.warn(`⚠️ ${operationName} attempt ${attempt} failed:`, error.message);
      if (attempt === maxRetries) {
        throw error;
      }
      await new Promise(resolve => setTimeout(resolve, CONFIG.RETRY_DELAY * attempt));
    }
  }
};

// 🏠 ГЛАВНОЕ МЕНЮ
bot.onText(/\/start/, async (msg) => {
  const chatId = msg.chat.id;
  
  try {
    await retryOperation(async () => {
      await User.findOneAndUpdate(
        { userId: chatId },
        { 
          userId: chatId, 
          username: msg.chat.username, 
          firstName: msg.chat.first_name,
          lastActivity: new Date()
        },
        { 
          upsert: true, 
          setDefaultsOnInsert: true
        }
      );
    }, "User update");

    const keyboard = [
      [{ text: '📅 1 MONTH VIP', callback_data: 'select_plan_1month' }],
      [{ text: '⭐ 3 MONTHS VIP', callback_data: 'select_plan_3months' }],
      [{ text: '🔍 MY SUBSCRIPTION', callback_data: 'my_subscription' }],
      [
        { text: '📞 SUPPORT', url: 'https://t.me/fxfeelgood' },
        { text: '📄 TERMS', url: `${process.env.RENDER_EXTERNAL_URL || 'http://localhost:10000'}/offer` }
      ]
    ];

    const welcomeMessage = `🚀 <b>WELCOME TO FXWAVE VIP ACCESS</b>, ${msg.chat.first_name}!

💎 <b>PREMIUM TRADING SIGNALS</b>
✅ High-accuracy forex & crypto signals
✅ Real-time market analysis  
✅ Professional trading insights
✅ 24/7 support

🎯 <b>CHOOSE YOUR VIP PLAN:</b>`;

    await bot.sendMessage(chatId, welcomeMessage, {
      parse_mode: 'HTML',
      reply_markup: { inline_keyboard: keyboard },
      disable_web_page_preview: true
    });

    logger('USER_STARTED', chatId, { 
      username: msg.chat.username,
      firstName: msg.chat.first_name 
    });

  } catch (error) {
    console.error('❌ START ERROR:', error);
    await bot.sendMessage(chatId, 
      '❌ <b>System temporarily unavailable</b>\nPlease try again in a few moments.',
      { parse_mode: 'HTML' }
    );
  }
});

// 🖱️ ОБРАБОТКА КНОПОК
bot.on('callback_query', async (callbackQuery) => {
  const chatId = callbackQuery.message.chat.id;
  const messageId = callbackQuery.message.message_id;
  const data = callbackQuery.data;

  try {
    await bot.answerCallbackQuery(callbackQuery.id);

    if (data.startsWith('select_plan_')) {
      await handlePlanSelection(chatId, messageId, data);
    } else if (data.startsWith('pay_')) {
      await handlePayment(chatId, messageId, data);
    } else if (data === 'my_subscription') {
      await handleSubscription(chatId);
    } else if (data === 'back_to_start') {
      await handleBack(chatId, messageId);
    }
  } catch (error) {
    console.error('❌ CALLBACK ERROR:', error);
    await bot.sendMessage(chatId, 
      '❌ <b>Action failed</b>\nPlease try again or contact support.',
      { parse_mode: 'HTML' }
    );
    
    logger('CALLBACK_ERROR', chatId, { 
      error: error.message, 
      data 
    });
  }
});

// 🔧 ОБРАБОТЧИКИ
async function handlePlanSelection(chatId, messageId, data) {
  const plan = data.split('_')[2];
  const planName = plan === '1month' ? '1 MONTH' : '3 MONTHS';
  
  const currencyButtons = [];
  
  if (process.env.TON_WALLET_ADDRESS) {
    currencyButtons.push([
      { 
        text: `🪙 PAY WITH TON - ${CONFIG.PRICES.TON[plan]} TON`, 
        callback_data: `pay_TON_${plan}` 
      }
    ]);
  }
  
  if (process.env.USDT_WALLET_ADDRESS) {
    currencyButtons.push([
      { 
        text: `💵 PAY WITH USDT - ${CONFIG.PRICES.USDT[plan]} USDT`, 
        callback_data: `pay_USDT_${plan}` 
      }
    ]);
  }

  if (currencyButtons.length === 0) {
    await bot.editMessageText(
      '❌ <b>PAYMENT UNAVAILABLE</b>\n\nAll payment methods are currently disabled.\nPlease contact support: @fxfeelgood',
      { 
        chat_id: chatId, 
        message_id: messageId,
        parse_mode: 'HTML'
      }
    );
    return;
  }

  currencyButtons.push([{ text: '🔙 BACK TO PLANS', callback_data: 'back_to_start' }]);

  const message = `💎 <b>${planName} VIP SUBSCRIPTION</b>

💰 <b>PRICING:</b>
${process.env.TON_WALLET_ADDRESS ? `🪙 ${CONFIG.PRICES.TON[plan]} TON` : ''}
${process.env.USDT_WALLET_ADDRESS ? `💵 ${CONFIG.PRICES.USDT[plan]} USDT` : ''}

📊 <b>BENEFITS:</b>
✅ Premium trading signals
✅ Real-time market analysis
✅ 24/7 VIP support
✅ High accuracy forecasts

💳 <b>CHOOSE PAYMENT METHOD:</b>`;

  await bot.editMessageText(message, {
    chat_id: chatId,
    message_id: messageId,
    parse_mode: 'HTML',
    reply_markup: { inline_keyboard: currencyButtons }
  });

  logger('PLAN_SELECTED', chatId, { plan });
}

async function handlePayment(chatId, messageId, data) {
  const [_, currency, plan] = data.split('_');
  const wallet = currency === 'TON' ? process.env.TON_WALLET_ADDRESS : process.env.USDT_WALLET_ADDRESS;
  
  if (!wallet) {
    await bot.answerCallbackQuery({
      text: `❌ ${currency} payments are currently unavailable`,
      show_alert: true
    });
    return;
  }

  const amount = CONFIG.PRICES[currency][plan];
  const paymentId = generatePaymentId();
  
  let qrData, instructions;

  if (currency === 'TON') {
    const nanoTons = Math.round(amount * 1e9);
    qrData = `ton://transfer/${wallet}?amount=${nanoTons}`;
    instructions = `💳 <b>PAY WITH TON</b>

📍 Send exactly <b>${amount} TON</b> to:
<code>${wallet}</code>

⚠️ <b>IMPORTANT:</b>
• Use TON network ONLY
• Send exact amount
• Network: <b>TON</b>
• Payment ID: <code>${paymentId}</code>`;
  } else {
    qrData = `tron:${wallet}?amount=${amount}`;
    instructions = `💳 <b>PAY WITH USDT (TRC20)</b>

📍 Send exactly <b>${amount} USDT</b> to:
<code>${wallet}</code>

⚠️ <b>CRITICAL:</b>
• Network: <b>TRON (TRC20) ONLY</b>
• Send exact amount
• Do NOT use other networks
• Payment ID: <code>${paymentId}</code>`;
  }

  try {
    const qrBuffer = await QRCode.toBuffer(qrData, { 
      errorCorrectionLevel: 'H',
      width: 400,
      margin: 4
    });

    await bot.sendPhoto(chatId, qrBuffer, {
      caption: instructions + `\n\n📨 After payment, send your <b>Transaction Hash (TXID)</b> here.`,
      parse_mode: 'HTML',
      reply_markup: {
        inline_keyboard: [
          [{ text: '🔙 CHOOSE DIFFERENT PLAN', callback_data: 'back_to_start' }],
          [{ text: '🆘 NEED HELP?', url: 'https://t.me/fxfeelgood' }]
        ]
      }
    });

    await retryOperation(async () => {
      await User.findOneAndUpdate(
        { userId: chatId },
        { 
          $set: { 
            pendingPayment: { 
              plan, 
              amount, 
              currency,
              paymentId,
              createdAt: new Date()
            } 
          } 
        }
      );
    }, "Payment setup");

    logger('PAYMENT_INITIATED', chatId, { 
      plan, 
      currency, 
      amount, 
      paymentId 
    });

  } catch (error) {
    console.error('❌ PAYMENT ERROR:', error);
    await bot.sendMessage(chatId,
      '❌ <b>Payment setup failed</b>\nPlease try again or contact support.',
      { parse_mode: 'HTML' }
    );
  }
}

async function handleSubscription(chatId) {
  try {
    const user = await retryOperation(
      () => User.findOne({ userId: chatId }),
      "User lookup"
    );
    
    if (!user || user.subscription === 'none') {
      await bot.sendMessage(chatId,
        `📊 <b>SUBSCRIPTION STATUS</b>\n\n❌ <b>NO ACTIVE SUBSCRIPTION</b>\nGet VIP access to premium trading signals!`,
        {
          parse_mode: 'HTML',
          reply_markup: {
            inline_keyboard: [[{ text: '🎫 VIEW PLANS', callback_data: 'back_to_start' }]]
          }
        }
      );
    } else {
      const now = new Date();
      const isExpired = user.expiresAt < now;
      const daysLeft = isExpired ? 0 : Math.ceil((user.expiresAt - now) / (1000 * 60 * 60 * 24));

      const statusMessage = isExpired ? 
        `📊 <b>SUBSCRIPTION STATUS</b>\n\n❌ <b>SUBSCRIPTION EXPIRED</b>\n📅 Expired on: <b>${user.expiresAt.toLocaleDateString()}</b>\n\nRenew your VIP access!` :
        `📊 <b>SUBSCRIPTION STATUS</b>\n\n✅ <b>ACTIVE: ${user.subscription.toUpperCase()} PLAN</b>\n⏰ Days remaining: <b>${daysLeft}</b>\n📅 Expires on: <b>${user.expiresAt.toLocaleDateString()}</b>\n🚀 Status: <b>VIP ACCESS ACTIVE</b>`;

      await bot.sendMessage(chatId, statusMessage, {
        parse_mode: 'HTML',
        reply_markup: {
          inline_keyboard: [[{ 
            text: isExpired ? '🔄 RENEW SUBSCRIPTION' : '⭐ UPGRADE PLAN', 
            callback_data: 'back_to_start' 
          }]]
        }
      });
    }

    logger('SUBSCRIPTION_CHECKED', chatId);

  } catch (error) {
    console.error('❌ SUBSCRIPTION ERROR:', error);
    await bot.sendMessage(chatId,
      '❌ <b>Unable to check subscription</b>\nPlease try again later.',
      { parse_mode: 'HTML' }
    );
  }
}

async function handleBack(chatId, messageId) {
  try {
    await bot.deleteMessage(chatId, messageId);
  } catch (error) {
    // Ignore delete errors
  }
  bot.emit('message', { 
    chat: { 
      id: chatId, 
      first_name: 'User',
      username: 'user'
    }, 
    text: '/start' 
  });
}

// 🧾 ОБРАБОТКА ТРАНЗАКЦИЙ
bot.on('message', async (msg) => {
  if (!msg.text || msg.text.startsWith('/')) return;

  const chatId = msg.chat.id;
  const txHash = msg.text.trim();

  if (!validateTxHash(txHash)) {
    return;
  }

  logger('TXID_RECEIVED', chatId, { txHash });

  await bot.sendMessage(chatId, 
    '⏳ <b>VERIFYING YOUR PAYMENT...</b>\nThis usually takes 10-30 seconds. Please wait...',
    { parse_mode: 'HTML' }
  );

  setTimeout(async () => {
    try {
      await processTransaction(chatId, txHash);
    } catch (error) {
      console.error('❌ TRANSACTION ERROR:', error);
      await bot.sendMessage(chatId,
        '❌ <b>Payment verification failed</b>\nPlease contact support: @fxfeelgood',
        { parse_mode: 'HTML' }
      );
      
      logger('TX_PROCESSING_ERROR', chatId, { 
        txHash, 
        error: error.message 
      });
    }
  }, CONFIG.PAYMENT_TIMEOUT);
});

async function processTransaction(chatId, txHash) {
  const user = await retryOperation(
    () => User.findOne({ userId: chatId }),
    "User lookup for transaction"
  );
  
  if (!user || !user.pendingPayment) {
    await bot.sendMessage(chatId,
      '⚠️ <b>NO PENDING PAYMENT FOUND</b>\nPlease select a plan first using /start',
      { parse_mode: 'HTML' }
    );
    return;
  }

  const existingTx = await User.findOne({ 'transactions.hash': txHash });
  if (existingTx) {
    await bot.sendMessage(chatId,
      '⚠️ <b>TRANSACTION ALREADY PROCESSED</b>\nThis TXID has already been used.',
      { parse_mode: 'HTML' }
    );
    return;
  }

  const { plan, amount, currency, paymentId } = user.pendingPayment;
  const expiresAt = calculateExpiry(plan);

  await retryOperation(async () => {
    await User.findOneAndUpdate(
      { userId: chatId },
      {
        subscription: plan,
        expiresAt,
        $unset: { pendingPayment: 1 },
        $push: {
          transactions: {
            hash: txHash,
            amount,
            currency,
            status: 'verified',
            verified: true,
            timestamp: new Date(),
            paymentId
          }
        }
      }
    );
  }, "User update after payment");

  const channelResult = await addToChannel(chatId);

  if (channelResult.success) {
    await bot.sendMessage(chatId,
      `🎉 <b>PAYMENT VERIFIED SUCCESSFULLY!</b>\n\n✅ <b>${plan === '1month' ? '1 MONTH' : '3 MONTHS'} VIP SUBSCRIPTION ACTIVATED</b>\n💎 You now have access to premium trading signals\n📈 Welcome to FXWave VIP community!\n🔗 You've been added to the VIP channel\n\n📊 Transaction ID: <code>${txHash.substring(0, 16)}...</code>`,
      { parse_mode: 'HTML' }
    );
    
    logger('SUBSCRIPTION_ACTIVATED', chatId, { 
      plan, 
      amount, 
      currency, 
      txHash,
      paymentId 
    });
  } else {
    await bot.sendMessage(chatId,
      `✅ <b>PAYMENT VERIFIED SUCCESSFULLY!</b>\n\n❌ <b>COULD NOT ADD TO VIP CHANNEL</b>\n\nPlease contact support: @fxfeelgood\nProvide this code: <code>${chatId}</code>\nPayment ID: <code>${paymentId}</code>`,
      { parse_mode: 'HTML' }
    );
    
    logger('SUBSCRIPTION_ACTIVATED_NO_CHANNEL', chatId, { 
      plan, 
      error: channelResult.error 
    });
  }
}

async function addToChannel(userId) {
  try {
    await bot.addChatMember(process.env.VIP_CHANNEL_ID, userId);
    return { success: true };
  } catch (error) {
    if (error.response?.body?.description?.includes('USER_ALREADY_PARTICIPANT')) {
      return { success: true, message: 'User already in channel' };
    }
    return { success: false, error: error.message };
  }
}

// 🧪 ТЕСТ КАНАЛА
bot.onText(/\/testchannel/, async (msg) => {
  const chatId = msg.chat.id;
  
  try {
    const chat = await bot.getChat(process.env.VIP_CHANNEL_ID);
    const admins = await bot.getChatAdministrators(process.env.VIP_CHANNEL_ID);
    const botInfo = await bot.getMe();
    
    const botAdmin = admins.find(a => a.user.id === botInfo.id);
    const canInvite = botAdmin && botAdmin.can_invite_users;

    await bot.sendMessage(chatId,
      `🔧 <b>CHANNEL TEST</b>\n\n📢 Channel: <b>${chat.title}</b>\n👑 Bot Admin: <b>${botAdmin ? 'YES' : 'NO'}</b>\n📨 Can Invite: <b>${canInvite ? 'YES' : 'NO'}</b>\n🔗 Channel ID: <code>${process.env.VIP_CHANNEL_ID}</code>\n\n✅ <b>SYSTEM STATUS: OPERATIONAL</b>`,
      { parse_mode: 'HTML' }
    );

    logger('CHANNEL_TEST', chatId, { 
      channelTitle: chat.title, 
      isAdmin: !!botAdmin, 
      canInvite
    });
  } catch (error) {
    await bot.sendMessage(chatId,
      `❌ <b>CHANNEL TEST FAILED</b>\n\nError: ${error.message}`,
      { parse_mode: 'HTML' }
    );
  }
});

// 🌐 ВЕБ СЕРВЕР
app.use(express.static('public'));
app.use(express.json());

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.get('/offer', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'offer.html'));
});

app.get('/health', async (req, res) => {
  const dbStatus = mongoose.connection.readyState === 1 ? 'connected' : 'disconnected';
  const botStatus = bot.isPolling() ? 'running' : 'stopped';
  const memoryUsage = process.memoryUsage();
  
  res.json({
    status: 'OK',
    timestamp: new Date().toISOString(),
    services: {
      database: dbStatus,
      bot: botStatus,
      web: 'running'
    },
    system: {
      uptime: process.uptime(),
      memory: {
        used: Math.round(memoryUsage.heapUsed / 1024 / 1024) + 'MB',
        total: Math.round(memoryUsage.heapTotal / 1024 / 1024) + 'MB'
      }
    }
  });
});

// 🖼️ QR ENDPOINT
app.get('/qr', async (req, res) => {
  const { currency = 'USDT', plan = '1month' } = req.query;
  
  if (!['USDT', 'TON'].includes(currency) || !['1month', '3months'].includes(plan)) {
    return res.status(400).json({ 
      error: 'Invalid parameters',
      allowed: {
        currency: ['USDT', 'TON'],
        plan: ['1month', '3months']
      }
    });
  }

  const wallet = currency === 'TON' ? process.env.TON_WALLET_ADDRESS : process.env.USDT_WALLET_ADDRESS;
  if (!wallet) {
    return res.status(400).json({ error: 'Payment method unavailable' });
  }

  const amount = CONFIG.PRICES[currency]?.[plan];
  if (!amount) {
    return res.status(400).json({ error: 'Invalid plan' });
  }

  try {
    let qrData;
    if (currency === 'TON') {
      const nanoTons = Math.round(amount * 1e9);
      qrData = `ton://transfer/${wallet}?amount=${nanoTons}`;
    } else {
      qrData = `tron:${wallet}?amount=${amount}`;
    }

    const qrBuffer = await QRCode.toBuffer(qrData, {
      errorCorrectionLevel: 'H',
      width: 400,
      margin: 4
    });

    res.setHeader('Content-Type', 'image/png');
    res.setHeader('Cache-Control', 'public, max-age=7200');
    res.setHeader('X-Amount', amount);
    res.setHeader('X-Currency', currency);
    res.setHeader('X-Plan', plan);
    
    res.send(qrBuffer);
  } catch (error) {
    console.error('❌ QR ERROR:', error);
    res.status(500).json({ error: 'QR generation failed' });
  }
});

// 🔁 KEEP-ALIVE
if (process.env.RENDER_EXTERNAL_URL) {
  setInterval(async () => {
    try {
      const response = await fetch(`${process.env.RENDER_EXTERNAL_URL}/health`);
      if (response.ok) {
        console.log('✅ KEEP-ALIVE: Successful');
      }
    } catch (error) {
      console.warn('⚠️ KEEP-ALIVE: Failed -', error.message);
    }
  }, CONFIG.KEEP_ALIVE_INTERVAL);
}

// 🗑️ ОЧИСТКА ПРОСРОЧЕННЫХ ПОДПИСОК
setInterval(async () => {
  try {
    const now = new Date();
    const expiredUsers = await User.find({
      expiresAt: { $lt: now },
      subscription: { $ne: 'none' }
    });

    console.log(`🔄 CLEANUP: Processing ${expiredUsers.length} expired subscriptions...`);

    for (const user of expiredUsers) {
      try {
        await bot.banChatMember(process.env.VIP_CHANNEL_ID, user.userId);
        await bot.unbanChatMember(process.env.VIP_CHANNEL_ID, user.userId);
        
        user.subscription = 'none';
        await user.save();
        
        await bot.sendMessage(user.userId,
          '❌ <b>YOUR VIP SUBSCRIPTION HAS EXPIRED</b>\n\nYour access to premium signals has been suspended.\nUse /start to renew your subscription!',
          { parse_mode: 'HTML' }
        ).catch(() => {});

        logger('SUBSCRIPTION_EXPIRED', user.userId);

      } catch (error) {
        console.log(`❌ CLEANUP: Failed to remove user ${user.userId}:`, error.message);
      }
    }

    console.log(`✅ CLEANUP: Completed processing ${expiredUsers.length} users`);

  } catch (error) {
    console.error('❌ CLEANUP ERROR:', error);
  }
}, CONFIG.CLEANUP_INTERVAL);

// ▶️ ЗАПУСК СЕРВЕРА
const startServer = async () => {
  try {
    await connectDB();
    
    app.listen(PORT, () => {
      console.log('🎉 BOT STARTED SUCCESSFULLY!');
      console.log(`🚀 Server running on port ${PORT}`);
      console.log(`📊 Environment: ${process.env.NODE_ENV || 'development'}`);
      console.log(`🔗 External URL: ${process.env.RENDER_EXTERNAL_URL || 'Not set'}`);
      console.log(`💾 Database: ${mongoose.connection.readyState === 1 ? 'Connected' : 'Disconnected'}`);
      console.log(`🤖 Bot: ${bot.isPolling() ? 'Polling' : 'Stopped'}`);
      console.log('='.repeat(50));
      
      logger('SERVER_STARTED', 'system', { 
        port: PORT, 
        environment: process.env.NODE_ENV || 'development' 
      });
    });
  } catch (error) {
    console.error('🚨 SERVER: Failed to start:', error);
    process.exit(1);
  }
};

// ❌ ОБРАБОТКА ОШИБОК
process.on('unhandledRejection', (reason, promise) => {
  console.error('❌ UNHANDLED REJECTION at:', promise, 'reason:', reason);
  logger('UNHANDLED_REJECTION', 'system', { 
    reason: reason?.toString() || 'Unknown reason' 
  });
});

process.on('uncaughtException', (error) => {
  console.error('❌ UNCAUGHT EXCEPTION:', error);
  logger('UNCAUGHT_EXCEPTION', 'system', { 
    error: error.message
  });
  process.exit(1);
});

process.on('SIGTERM', async () => {
  console.log('🔄 Received SIGTERM, shutting down gracefully...');
  bot.stopPolling();
  await mongoose.connection.close();
  console.log('✅ Graceful shutdown completed');
  process.exit(0);
});

process.on('SIGINT', async () => {
  console.log('🔄 Received SIGINT, shutting down gracefully...');
  bot.stopPolling();
  await mongoose.connection.close();
  console.log('✅ Graceful shutdown completed');
  process.exit(0);
});

// 🚀 ЗАПУСК БОТА!
startServer();