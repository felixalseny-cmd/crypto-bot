function selectPlan(plan) {
  const prices = { '1month': 24, '3months': 55 };
  const price = prices[plan];
  alert(`Selected ${plan} plan for ${price} USDT. Please send payment to the wallet address above.`);
}

function copyWalletAddress() {
  const walletAddress = document.getElementById('walletAddress').textContent;
  navigator.clipboard.writeText(walletAddress).then(() => {
    alert('Wallet address copied to clipboard!');
  }).catch(err => {
    console.error('Failed to copy:', err);
  });
}
function copyWalletAddress() {
  alert('Use buttons below QR to copy');
}