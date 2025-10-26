require('dotenv').config();
const express = require('express');
const TelegramBot = require('node-telegram-bot-api');
const mongoose = require('mongoose');
const QRCode = require('qrcode');
const path = require('path');
const app = express();
const PORT = process.env.PORT || 10000;

// 🔑 Проверка переменных окружения
const required = ['BOT_TOKEN', 'MONGODB_URI', 'VIP_CHANNEL_ID'];
const walletRequired = ['USDT_WALLET_ADDRESS', 'TON_WALLET_ADDRESS'];

for (const key of required) {
  if (!process.env[key]) {
    console.error(`❌ Missing required environment variable: ${key}`);
    process.exit(1);
  }
}
for (const key of walletRequired) {
  if (!process.env[key]) {
    console.warn(`⚠️ Missing wallet address: ${key}. Payments in this currency will be disabled.`);
  }
}

// 🗄️ Подключение к MongoDB
mongoose.connect(process.env.MONGODB_URI)
  .then(() => console.log('✅ MongoDB connected'))
  .catch(err => {
    console.error('❌ MongoDB error:', err.message);
    setTimeout(() => process.exit(1), 5000);
  });

// 👤 Модель пользователя
const userSchema = new mongoose.Schema({
  userId: { type: Number, required: true, unique: true },
  username: String,
  firstName: String,
  subscription: { type: String, default: 'none' },
  expiresAt: Date,
  pendingPayment: { plan: String, amount: Number, currency: String },
  transactions: [{
    hash: { type: String, unique: true },
    amount: Number,
    currency: { type: String, default: 'USDT' },
    status: { type: String, default: 'pending' },
    timestamp: { type: Date, default: Date.now }
  }]
});
const User = mongoose.model('User', userSchema);

// 🤖 Telegram Bot
const bot = new TelegramBot(process.env.BOT_TOKEN, { polling: true });

// 🏠 Функция отправки стартового меню
async function sendStartMenu(chatId, firstName) {
  const keyboard = [
    [{ text: '📅 1 Month', callback_data: 'select_plan_1month' }],
    [{ text: '⭐ 3 Months', callback_ 'select_plan_3months' }],
    [{ text: 'ℹ️ My Subscription', callback_data: 'my_subscription' }]
  ];
  await bot.sendMessage(chatId, `🚀 Welcome to FXWave VIP Access, ${firstName}!\nChoose your plan:`, {
    reply_markup: { inline_keyboard: keyboard }
  });
}

// 📡 /start
bot.onText(/\/start/, async (msg) => {
  const chatId = msg.chat.id;
  await User.findOneAndUpdate(
    { userId: chatId },
    { userId: chatId, username: msg.chat.username, firstName: msg.chat.first_name },
    { upsert: true, setDefaultsOnInsert: true }
  );
  await sendStartMenu(chatId, msg.chat.first_name);
});

// 🖱️ Обработка кнопок
bot.on('callback_query', async (callbackQuery) => {
  const chatId = callbackQuery.message.chat.id;
  const data = callbackQuery.data;
  try {
    if (data.startsWith('select_plan_')) {
      const plan = data.split('_')[2];
      const tonAvailable = !!process.env.TON_WALLET_ADDRESS;
      const usdtAvailable = !!process.env.USDT_WALLET_ADDRESS;
      const currencyButtons = [];
      if (tonAvailable) {
        currencyButtons.push([{ text: '🪙 TON', callback_ `pay_TON_${plan}` }]);
      }
      if (usdtAvailable) {
        currencyButtons.push([{ text: '💵 USDT (TRC20)', callback_ `pay_USDT_${plan}` }]);
      }
      if (currencyButtons.length === 0) {
        await bot.editMessageText(
          '❌ Payment is temporarily unavailable. Please contact support.',
          { chat_id: chatId, message_id: callbackQuery.message.message_id }
        );
        return;
      }
      currencyButtons.push([{ text: '🔙 Back', callback_ 'back_to_start' }]);
      await bot.editMessageText(
        `💳 Choose currency for <b>${plan === '1month' ? '1 Month' : '3 Months'}</b>:`,
        {
          chat_id: chatId,
          message_id: callbackQuery.message.message_id,
          parse_mode: 'HTML',
          reply_markup: { inline_keyboard: currencyButtons }
        }
      );
    } else if (data.startsWith('pay_')) {
      const [_, currency, plan] = data.split('_');
      const wallet = currency === 'TON' ? process.env.TON_WALLET_ADDRESS : process.env.USDT_WALLET_ADDRESS;
      if (!wallet) {
        await bot.answerCallbackQuery(callbackQuery.id, {
          text: `❌ ${currency} payments are temporarily unavailable`,
          show_alert: true
        });
        return;
      }
      const prices = { USDT: { '1month': 24, '3months': 55 }, TON: { '1month': 11, '3months': 25 } };
      const amount = prices[currency][plan];
      let qrData;
      if (currency === 'TON') {
        const nanoTons = Math.round(amount * 1e9);
        qrData = `ton://transfer/${wallet}?amount=${nanoTons}`;
      } else {
        qrData = `tron:${wallet}?amount=${amount}`;
      }
      const qrBuffer = await QRCode.toBuffer(qrData, { errorCorrectionLevel: 'M' });
      const caption = currency === 'TON'
        ? `💳 <b>Pay with TON</b>\n📍 Send exactly <b>${amount} TON</b> to:\n🟢 <code>${wallet}</code>\n<i>This address is for TON network only</i>`
        : `💳 <b>Pay with USDT (TRC20)</b>\n📍 Send exactly <b>${amount} USDT</b> to:\n<code>${wallet}</code>\n⚠️ Network: <b>TRON (TRC20)</b>`;
      await bot.sendPhoto(chatId, qrBuffer, {
        caption,
        parse_mode: 'HTML',
        reply_markup: { inline_keyboard: [[{ text: '🔙 Back', callback_ 'back_to_start' }]] }
      });
      await User.findOneAndUpdate({ userId: chatId }, { $set: { pendingPayment: { plan, amount, currency } } });
    } else if (data === 'my_subscription') {
      const user = await User.findOne({ userId: chatId });
      if (!user || user.subscription === 'none') {
        await bot.sendMessage(chatId,
          `📊 <b>Your Subscription Status</b>\n❌ No active subscription\nChoose a plan to get VIP access!`,
          { parse_mode: 'HTML', reply_markup: { inline_keyboard: [[{ text: '🎫 View Plans', callback_ 'back_to_start' }]] } }
        );
      } else {
        const now = new Date();
        const days = user.expiresAt > now ? Math.ceil((user.expiresAt - now) / (1000 * 60 * 60 * 24)) : 0;
        await bot.sendMessage(chatId,
          `📊 <b>Your Subscription Status</b>\n` +
          `✅ Plan: <b>${user.subscription.toUpperCase()}</b>\n` +
          `⏰ Expires in: <b>${days} days</b>\n` +
          `📅 Expiry: <b>${user.expiresAt.toLocaleDateString()}</b>`,
          { parse_mode: 'HTML', reply_markup: { inline_keyboard: [[{ text: '🔄 Renew', callback_ 'back_to_start' }]] } }
        );
      }
    } else if (data === 'back_to_start') {
      try {
        await bot.deleteMessage(chatId, callbackQuery.message.message_id);
      } catch (e) { /* ignore */ }
      const user = await User.findOne({ userId: chatId });
      await sendStartMenu(chatId, user?.firstName || 'User');
    }
  } catch (error) {
    console.error('Callback error:', error);
    await bot.sendMessage(chatId, '❌ An error occurred. Please try again.', { parse_mode: 'HTML' });
  }
});

// 🧾 Обработка TXID (временно — без реальной верификации)
bot.on('message', async (msg) => {
  if (!msg.text || msg.text.startsWith('/')) return;
  const chatId = msg.chat.id;
  const tx = msg.text.trim();

  if (tx.length === 64 && /^[a-fA-F0-9]+$/.test(tx)) {
    await bot.sendMessage(chatId, '⏳ Verifying payment... (manual check may be required)', { parse_mode: 'HTML' });

    try {
      const user = await User.findOne({ userId: chatId });
      if (!user || !user.pendingPayment) {
        return await bot.sendMessage(chatId,
          '⚠️ No pending subscription found. Please select a plan first via /start.',
          { parse_mode: 'HTML' }
        );
      }

      // Проверка на дубликат транзакции
      const existingTx = await User.findOne({ 'transactions.hash': tx });
      if (existingTx) {
        return await bot.sendMessage(chatId,
          '⚠️ This transaction ID has already been used. Contact support if this is an error.',
          { parse_mode: 'HTML' }
        );
      }

      const { plan, amount, currency } = user.pendingPayment;
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
              amount,
              currency,
              status: 'completed',
              timestamp: new Date()
            }
          }
        }
      );

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
          `✅ <b>Payment Accepted!</b>\nYour <b>${plan}</b> VIP subscription is now active!\n🎉 You're in the VIP channel!`,
          { parse_mode: 'HTML' }
        );
      } else {
        await bot.sendMessage(chatId,
          `✅ <b>Payment Accepted!</b>\nYour subscription is active!\n⚠️ <b>Could not auto-add you.</b> Contact: @fxfeelgood`,
          { parse_mode: 'HTML' }
        );
      }

    } catch (error) {
      console.error('TX processing error:', error);
      await bot.sendMessage(chatId, '❌ Failed to process payment. Contact support: @fxfeelgood', { parse_mode: 'HTML' });
    }
  }
});

// 🧪 /testchannel
bot.onText(/\/testchannel/, async (msg) => {
  const chatId = msg.chat.id;
  try {
    const chat = await bot.getChat(process.env.VIP_CHANNEL_ID);
    await bot.sendMessage(chatId, `✅ Channel: ${chat.title}`);
    const admins = await bot.getChatAdministrators(process.env.VIP_CHANNEL_ID);
    const botInfo = await bot.getMe();
    const isBotAdmin = admins.some(a => a.user.id === botInfo.id && a.can_invite_users);
    await bot.sendMessage(chatId, isBotAdmin ? '✅ Bot is admin with invite rights' : '❌ Bot is NOT admin');
  } catch (e) {
    await bot.sendMessage(chatId, `❌ Error: ${e.message}`);
  }
});

// 🌐 Web server
app.use(express.static('public'));
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});
app.get('/health', (req, res) => {
  res.json({ status: 'OK', db: mongoose.connection.readyState === 1 ? 'connected' : 'disconnected' });
});

// 🖼️ QR endpoint
app.get('/qr', async (req, res) => {
  const { currency = 'USDT', plan = '1month' } = req.query;
  const wallet = currency === 'TON' ? process.env.TON_WALLET_ADDRESS : process.env.USDT_WALLET_ADDRESS;
  if (!wallet) {
    return res.status(400).send('Payment method unavailable');
  }
  const prices = { USDT: { '1month': 24, '3months': 55 }, TON: { '1month': 11, '3months': 25 } };
  const amount = prices[currency]?.[plan] || (currency === 'TON' ? 11 : 24);
  let data = currency === 'TON'
    ? `ton://transfer/${wallet}?amount=${Math.round(amount * 1e9)}`
    : `tron:${wallet}?amount=${amount}`;
  try {
    const qrBuffer = await QRCode.toBuffer(data, { errorCorrectionLevel: 'M' });
    res.setHeader('Content-Type', 'image/png');
    res.setHeader('Cache-Control', 'public, max-age=3600');
    res.send(qrBuffer);
  } catch (err) {
    console.error('QR error:', err);
    res.status(500).send('QR generation failed');
  }
});

// 🔁 Keep-alive для Render
if (process.env.RENDER_EXTERNAL_URL) {
  setInterval(async () => {
    try {
      await fetch(`${process.env.RENDER_EXTERNAL_URL}/health`);
    } catch (e) { /* ignore */ }
  }, 14 * 60 * 1000);
}

// 🗑️ Удаление просроченных подписок
setInterval(async () => {
  try {
    const now = new Date();
    const expired = await User.find({
      expiresAt: { $lt: now },
      subscription: { $ne: 'none' }
    });
    for (const user of expired) {
      try {
        await bot.banChatMember(process.env.VIP_CHANNEL_ID, user.userId);
        await bot.unbanChatMember(process.env.VIP_CHANNEL_ID, user.userId);
        user.subscription = 'none';
        await user.save();
        await bot.sendMessage(user.userId, "❌ Your VIP subscription has expired.");
      } catch (e) {
        console.log("Failed to remove user", user.userId, e.message);
      }
    }
  } catch (error) {
    console.error('Error in subscription cleanup:', error);
  }
}, 60 * 60 * 1000);

// ▶️ Запуск сервера
app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
});

// ❌ Обработка ошибок
process.on('unhandledRejection', (reason) => {
  console.error('❌ Unhandled Rejection:', reason);
});
process.on('uncaughtException', (error) => {
  console.error('❌ Uncaught Exception:', error);
  process.exit(1);
});
