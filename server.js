const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const AWS = require('aws-sdk');
const crypto = require('crypto');
const { connectDB, UtmClick } = require('./db');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 8080;

// AWS Secrets Manager client
const secretsManager = new AWS.SecretsManager({
  region: process.env.AWS_REGION || 'ap-south-1'
});

// Immediate server startup with minimal configuration
const server = app.listen(PORT, '0.0.0.0', () => {
  console.log(`✅ Server listening on port ${PORT}`);
  console.log('📍 Immediate endpoints available: /health');
});

// Global error handling
process.on('unhandledRejection', (reason) => {
  console.error('⚠️ Unhandled Rejection:', reason);
});

process.on('uncaughtException', (error) => {
  console.error('🚨 Uncaught Exception:', error);
});

server.on('error', (err) => {
  console.error('❌ Server error:', err);
  process.exit(1);
});

// Essential middleware
app.use(cors());
app.use(helmet());
app.use(express.json());

// Health endpoint (available immediately)
app.get('/health', (req, res) => {
  res.status(200).json({
    status: 'healthy',
    timestamp: new Date().toISOString(),
  });
});

// Secret caching
const secretCache = new Map();

async function getSecret(secretName) {
  if (secretCache.has(secretName)) {
    return secretCache.get(secretName);
  }

  try {
    const data = await secretsManager.getSecretValue({ SecretId: secretName }).promise();
    const secretValue = data.SecretString;
    secretCache.set(secretName, secretValue);
    return secretValue;
  } catch (error) {
    console.error(`❌ Failed to retrieve secret ${secretName}:`, error.message);
    throw error;
  }
}

// Deferred initialization
setImmediate(async () => {
  try {
    console.log('🚀 Starting async initialization...');

    // Connect to MongoDB
    await connectDB();
    console.log('✅ MongoDB connected successfully');

    // Security middleware - Gallabox webhook verification
    const verifyGallabox = async (req, res, next) => {
      try {
        const token = req.headers['x-gallabox-token'];
        
        // Get token from environment or secrets manager
        let gallaboxToken = process.env.GALLABOX_TOKEN;
        if (!gallaboxToken) {
          gallaboxToken = await getSecret('utm-tracker/gallabox-token');
        }
        
        if (token !== gallaboxToken) {
          return res.status(401).send('Invalid token');
        }
        next();
      } catch (error) {
        console.error('❌ Token verification error:', error);
        res.status(500).send('Authentication failed');
      }
    };

    // Enhanced Gallabox Webhook Handler
    app.post('/gallabox-webhook', verifyGallabox, async (req, res) => {
      try {
        const event = req.body;
        console.log('📥 Incoming webhook payload:', JSON.stringify(event, null, 2));

        // Check if this is for the American Hairline number
        const receivingNumber = (event.channelNumber || '').replace(/\D/g, '');
        const americanHairlineNumber = process.env.WHATSAPP_NUMBER || '919137279145';
        
        console.log('🔍 DEBUG: channelNumber received:', receivingNumber);
        
        if (receivingNumber !== americanHairlineNumber) {
          console.log(`⏭️ Skipping: Message was for ${receivingNumber}, not American Hairline`);
          return res.status(200).json({ status: 'skipped', reason: 'wrong_number' });
        }

        // Extract critical identifiers
        const senderPhone = event.whatsapp?.from?.replace(/^0+/, '') || '';
        const contactId = event.contactId || event.contact?.id || null;
        const conversationId = event.conversationId || null;
        const contactName = event.contact?.name || null;
        const messageContent = event.whatsapp?.text?.body || 
                               (event.whatsapp?.interactive?.list_reply?.title || 'No text content');
        
        // Phone number normalization
        let normalizedPhone = senderPhone;
        const countryCode = '91';
        if (normalizedPhone && !normalizedPhone.startsWith(countryCode)) {
          normalizedPhone = `${countryCode}${normalizedPhone}`;
        }

        if (!normalizedPhone) {
          return res.status(400).json({ error: 'Missing phone number' });
        }

        let sessionId;
        let utmData = {
          source: 'direct_message',
          medium: 'whatsapp',
          campaign: 'organic',
          content: 'none'
        };
        let attribution = 'direct';
        
        // Matching Priority 1: Context Parameter
        if (event.context) {
          try {
            const context = JSON.parse(Buffer.from(event.context, 'base64').toString());
            if (context?.session_id) {
              sessionId = context.session_id;
              utmData = context;
              attribution = 'context';
              console.log(`✅ Context match: ${sessionId}`);
            }
          } catch (err) {
            console.warn('⚠️ Invalid context format:', err);
          }
        }

        // Matching Priority 2: Gallabox Identifiers
        if (!sessionId && (contactId || conversationId)) {
          console.log(`🔍 Attempting Gallabox ID match - Contact: ${contactId}, Conversation: ${conversationId}`);
          
          const fiveMinutesAgo = new Date(Date.now() - 5 * 60 * 1000);

          const recentClick = await UtmClick.findOne({
            hasEngaged: false,
            timestamp: { $gte: fiveMinutesAgo }
          })
          .sort({ timestamp: -1 })
          .limit(1);

          if (recentClick) {
            sessionId = recentClick._id.toString();
            utmData = recentClick.toObject();
            attribution = 'gallabox_id_match';
            console.log(`✅ Matched with recent click: ${sessionId}`);

            // Update click record with Gallabox IDs
            await UtmClick.findByIdAndUpdate(sessionId, {
              contactId,
              conversationId,
              contactName: contactName || null
            });
          }
        }

        // Matching Priority 3: Phone Number (if available in click records)
        if (!sessionId) {
          const phoneMatch = await UtmClick.findOne({
            phoneNumber: normalizedPhone,
            hasEngaged: false
          })
          .sort({ timestamp: -1 })
          .limit(1);

          if (phoneMatch) {
            sessionId = phoneMatch._id.toString();
            utmData = phoneMatch.toObject();
            attribution = 'phone_match';
            console.log(`✅ Phone number match: ${sessionId}`);
          }
        }

        // Start of Modified Direct Message Handling
        if (!sessionId) {
          if (conversationId) {
            const existingDirect = await UtmClick.findOne({
              conversationId: conversationId,
              source: 'direct_message'
            });

            if (existingDirect) {
              sessionId = existingDirect._id.toString();
              attribution = 'existing_direct';
              console.log(`✅ Found existing direct conversation: ${conversationId}`);

              await UtmClick.findByIdAndUpdate(sessionId, {
                lastMessage: messageContent,
                engagedAt: new Date()
              });
            } else if (process.env.STORE_DIRECT_MESSAGES === 'true') {
              sessionId = `direct-${Date.now()}-${crypto.randomUUID().slice(0, 8)}`;
              attribution = 'new_direct';
              console.log(`📝 Creating new direct record: ${sessionId}`);
              
              await UtmClick.create({
                _id: sessionId,
                ...utmData,
                timestamp: new Date(),
                hasEngaged: true,
                phoneNumber: normalizedPhone,
                lastMessage: messageContent,
                engagedAt: new Date(),
                syncedToSheets: false,
                contactId,
                conversationId,
                contactName
              });
            } else {
              console.log(`⏭️ Skipping direct message from ${normalizedPhone}`);
              attribution = 'ignored_direct';
              sessionId = 'not_stored';
            }
          }
        }
        // End of Modified Direct Message Handling

        // Update existing records
        if (attribution !== 'new_direct' && sessionId !== 'not_stored') {
          const updateData = {
            hasEngaged: true,
            phoneNumber: normalizedPhone,
            engagedAt: new Date(),
            syncedToSheets: false,
            attribution_source: attribution,
            contactId,
            conversationId,
            ...(contactName && { contactName }),
            ...(messageContent && { lastMessage: messageContent })
          };

          const existingDoc = await UtmClick.findById(sessionId);
          
          if (existingDoc) {
            await UtmClick.findByIdAndUpdate(sessionId, updateData);
          } else {
            await UtmClick.create({
              _id: sessionId,
              ...utmData,
              ...updateData,
              timestamp: new Date()
            });
          }
        }

        console.log(`✅ Processed message from ${normalizedPhone} with attribution: ${attribution}`);
        res.status(200).json({ 
          status: 'processed',
          sessionId,
          source: utmData.source,
          attribution
        });

      } catch (err) {
        console.error('❌ Webhook processing error:', err);
        res.status(500).json({ 
          error: 'Processing failed',
          details: err.message
        });
      }
    });

    // Store Click Endpoint
    app.post('/store-click', async (req, res) => {
      try {
        const { session_id, original_params, ...rawData } = req.body;
        
        // Extract values with consistent naming
        const params = original_params || {};
        
        // Create standardized structure
        const utmData = {
          source: params.source || rawData.source || 'facebook',
          medium: params.medium || rawData.medium || 'fb_ads',
          campaign: params.campaign || rawData.campaign || 'unknown',
          content: params.content || rawData.content || 'unknown',
          placement: params.placement || rawData.placement || 'unknown',
          
          original_params: {
            ...params,
            campaign: params.campaign || rawData.campaign || 'unknown',
            medium: params.medium || rawData.medium || 'fb_ads',
            source: params.source || rawData.source || 'facebook',
            content: params.content || rawData.content || 'unknown',
            placement: params.placement || rawData.placement || 'unknown'
          },
          
          click_time: new Date()
        };

        // Check if document already exists
        const existing = await UtmClick.findById(session_id);
        
        if (!existing) {
          await UtmClick.create({
            _id: session_id,
            ...utmData,
            timestamp: new Date(),
            hasEngaged: false,
            syncedToSheets: false
          });
        }
        
        res.status(201).json({ 
          message: 'Click stored',
          session_id: session_id
        });
      } catch (err) {
        console.error('❌ Storage error:', err);
        res.status(500).json({ error: 'Database operation failed' });
      }
    });

    // Readiness endpoint
    app.get('/readiness', async (req, res) => {
      try {
        // Check MongoDB connection
        await UtmClick.findOne().limit(1);
        res.status(200).json({ status: 'ready' });
      } catch (err) {
        res.status(500).json({ error: 'Not ready' });
      }
    });

    // Initialize Google Sheets sync
    const { scheduledSync, setupRealtimeSync } = require('./google-sheets-sync');
    
    // Setup scheduled sync endpoint
    app.post('/scheduled-sync', async (req, res) => {
      try {
        const result = await scheduledSync();
        res.status(200).json(result);
      } catch (err) {
        res.status(500).json({ error: err.message });
      }
    });
    
    // Initialize real-time sync listener
    let unsubscribeSheetsSync;
    try {
      unsubscribeSheetsSync = await setupRealtimeSync();
      console.log('✅ Real-time sheets sync initialized');
    } catch (err) {
      console.error('⚠️ Real-time sync setup failed:', err.message);
    }
    
    // Cleanup on server shutdown
    process.on('SIGTERM', () => {
      console.log('⚠️ Shutting down, cleaning up listeners...');
      if (unsubscribeSheetsSync) unsubscribeSheetsSync();
      server.close();
    });

    console.log('✅ Async initialization completed');

  } catch (err) {
    console.error('🚨 Critical initialization error:', err);
    server.close(() => process.exit(1));
  }
});

module.exports = app;
