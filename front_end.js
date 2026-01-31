document.addEventListener('DOMContentLoaded', () => {
    // =============================================
    // 1. Configuration & Constants
    // =============================================
    const whatsappNumber = '919137279145';
    
    // 🚨 UPDATE THIS URL AFTER AWS DEPLOYMENT
    // Get this from: AWS Console → App Runner → Your Service → Default domain
    const trackingEndpoint = 'https://YOUR-APP-RUNNER-URL.ap-south-1.awsapprunner.com/store-click';
    
    const defaultMessage = 'Hello!';
    const MAX_RETRIES = 8;
    const POLL_INTERVAL = 250;

    // =============================================
    // 2. Enhanced Parameter Handling
    // =============================================
    const getParam = (names) => {
        const params = new URLSearchParams(window.location.search);
        
        // Check all name variations: original, lowercase, and underscore variants
        for (const name of names) {
            const variations = [
                name,
                name.toLowerCase(),
                name.replace(/ /g, '_'),
                name.replace(/_/g, ' ')
            ];
            
            for (const variant of variations) {
                const value = params.get(variant);
                if (value) return decodeURIComponent(value);
            }
        }
        return '';
    };

    // =============================================
    // 3. Unified Tracking Data Construction
    // =============================================
    function buildTrackingData(sessionId) {
        return {
            source: getParam(['Campaign Source', 'utm_source', 'site_source_name']) || 'facebook',
            medium: getParam(['Ad Set Name', 'utm_medium', 'adset.name']) || 'fb_ads',
            campaign: getParam(['Campaign Name', 'utm_campaign', 'campaign.name']) || 'unknown',
            content: getParam(['Ad Name', 'utm_content', 'ad.name']) || 'unknown',
            placement: getParam(['Placement', 'utm_placement']) || 'unknown',
            gallabox_id: getParam(['gbx_id', 'gallabox_contact']),
            original_params: Object.fromEntries(new URLSearchParams(window.location.search)),
            session_id: sessionId,
            full_url: window.location.href,
            click_time: new Date().toISOString()
        };
    }

    // =============================================
    // 4. Core Click Handler
    // =============================================
    async function handleWhatsAppClick(e) {
        e.preventDefault();
        e.stopPropagation();

        const sessionId = `wa-${Date.now()}-${crypto.randomUUID().slice(0, 8)}`;
        const utmData = buildTrackingData(sessionId);

        try {
            const response = await fetch(trackingEndpoint, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(utmData)
            });

            if (!response.ok) throw new Error(`HTTP error ${response.status}`);

            const contextData = {
                session_id: sessionId,
                source: utmData.source,
                medium: utmData.medium,
                campaign: utmData.campaign,
                placement: utmData.placement,
                click_time: utmData.click_time
            };

            const encodedContext = btoa(JSON.stringify(contextData));
            window.open(
                `https://api.whatsapp.com/send/?phone=${whatsappNumber}` +
                `&text=${encodeURIComponent(defaultMessage)}` +
                `&context=${encodedContext}`,
                '_blank'
            );

        } catch (error) {
            console.error('Tracking failed:', error);
            window.open(`https://api.whatsapp.com/send/?phone=${whatsappNumber}`, '_blank');
        }
    }

    // =============================================
    // 5. Robust Event Binding System
    // =============================================
    function attachHandler(button) {
        if (button && !button.dataset.trackingAttached) {
            button.addEventListener('click', handleWhatsAppClick);
            button.dataset.trackingAttached = "true";
            console.log("Tracking successfully attached to:", button);
        }
    }

    // Immediate binding attempt
    const initialButton = document.querySelector([
        '[data-channel="Whatsapp"] a.chaty-tooltip',
        '.chaty-channel.Whatsapp-channel a',
        'a[href*="wa.me"]'
    ].join(','));
    attachHandler(initialButton);

    // Polling fallback mechanism
    let pollCount = 0;
    const poller = setInterval(() => {
        const button = document.querySelector([
            '[data-channel="Whatsapp"] a.chaty-tooltip',
            '.chaty-channel.Whatsapp-channel a',
            'a[href*="wa.me"]'
        ].join(','));
        
        if (button || pollCount++ >= MAX_RETRIES) {
            clearInterval(poller);
            if (button) attachHandler(button);
        }
    }, POLL_INTERVAL);

    // MutationObserver for dynamic content
    const observer = new MutationObserver(mutations => {
        mutations.forEach(({ addedNodes }) => {
            addedNodes.forEach(node => {
                const elements = node.nodeType === 1 ? 
                    [node, ...node.querySelectorAll('*')] : 
                    [];
                
                elements.forEach(element => {
                    if (element.matches?.('[data-channel="Whatsapp"], [href*="wa.me"]')) {
                        attachHandler(element);
                    }
                });
            });
        });
    });

    observer.observe(document.body, {
        childList: true,
        subtree: true,
        attributes: true,
        attributeFilter: ['data-channel', 'href']
    });

    // Chaty-specific event listener
    document.addEventListener('chaty.widget_ready', () => {
        const button = document.querySelector('[data-channel="Whatsapp"] a.chaty-tooltip');
        attachHandler(button);
    });
});
