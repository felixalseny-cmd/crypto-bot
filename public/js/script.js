// FXWave VIP - Main JavaScript
document.addEventListener('DOMContentLoaded', function() {
    console.log('FXWave VIP loaded successfully');
    
    // Initialize tooltips and interactive elements
    initializeApp();
});

function initializeApp() {
    // Add loading states to buttons
    const buttons = document.querySelectorAll('button');
    buttons.forEach(button => {
        button.addEventListener('click', function(e) {
            // Add loading animation to subscription buttons
            if (this.textContent.includes('Subscribe')) {
                const originalText = this.innerHTML;
                this.innerHTML = '<i data-feather="loader" class="animate-spin mr-2"></i> Processing...';
                feather.replace();
                
                // Reset after 2 seconds
                setTimeout(() => {
                    this.innerHTML = originalText;
                    feather.replace();
                }, 2000);
            }
        });
    });
    
    // Add intersection observer for animations
    const observerOptions = {
        threshold: 0.1,
        rootMargin: '0px 0px -50px 0px'
    };
    
    const observer = new IntersectionObserver(function(entries) {
        entries.forEach(entry => {
            if (entry.isIntersecting) {
                entry.target.classList.add('animate-fade-in-up');
            }
        });
    }, observerOptions);
    
    // Observe all subscription cards and features
    const elementsToAnimate = document.querySelectorAll('.subscription-card, .bg-gray-900');
    elementsToAnimate.forEach(el => {
        observer.observe(el);
    });
    
    // Add keyboard navigation
    document.addEventListener('keydown', function(e) {
        // ESC key to close modals (if any)
        if (e.key === 'Escape') {
            // Close any open modals
        }
        
        // Enter key on wallet address to copy
        if (e.key === 'Enter' && e.target.id === 'walletAddress') {
            copyWalletAddress();
        }
    });
}

// Utility functions
function formatUSDT(amount) {
    return new Intl.NumberFormat('en-US', {
        minimumFractionDigits: 0,
        maximumFractionDigits: 0
    }).format(amount);
}

// Network status indicator
function updateNetworkStatus() {
    const statusElement = document.getElementById('networkStatus');
    if (statusElement) {
        if (navigator.onLine) {
            statusElement.innerHTML = '<i data-feather="wifi" class="w-4 h-4 text-green-400"></i> Online';
        } else {
            statusElement.innerHTML = '<i data-feather="wifi-off" class="w-4 h-4 text-red-400"></i> Offline';
        }
        feather.replace();
    }
}

// Initialize network status
window.addEventListener('online', updateNetworkStatus);
window.addEventListener('offline', updateNetworkStatus);
updateNetworkStatus();

// Export for module usage if needed
if (typeof module !== 'undefined' && module.exports) {
    module.exports = { initializeApp, formatUSDT };
}