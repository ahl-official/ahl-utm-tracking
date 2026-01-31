const { UtmClick } = require('./db');
const { GoogleAuth } = require('google-auth-library');
const { sheets } = require('@googleapis/sheets');
const AWS = require('aws-sdk');
require('dotenv').config();

const secretsManager = new AWS.SecretsManager({
  region: process.env.AWS_REGION || 'ap-south-1'
});

// Initialize Google Sheets API client
async function initializeSheetsClient() {
  try {
    // Get Google credentials from AWS Secrets Manager or environment
    let credentialsJson = process.env.GOOGLE_CREDENTIALS;
    
    if (!credentialsJson) {
      const data = await secretsManager.getSecretValue({ 
        SecretId: 'utm-tracker/google-credentials' 
      }).promise();
      credentialsJson = data.SecretString;
    }

    const credentials = JSON.parse(credentialsJson);

    const auth = new GoogleAuth({
      scopes: [
        'https://www.googleapis.com/auth/spreadsheets',
        'https://www.googleapis.com/auth/drive'
      ],
      credentials
    });

    return sheets({ version: 'v4', auth: await auth.getClient() });
  } catch (error) {
    console.error('🔥 Sheets client initialization failed:', error.message);
    throw error;
  }
}

function convertToSheetRows(docs) {
  return docs.map(doc => {
    const data = doc.toObject ? doc.toObject() : doc;
    console.log('Processing document ID:', doc._id);

    // Extract timestamps with proper handling
    let timestamp;
    if (data.click_time) {
      timestamp = new Date(data.click_time);
    } else if (data.timestamp) {
      timestamp = new Date(data.timestamp);
    } else {
      timestamp = new Date();
    }

    // Extract engagement timestamp
    let engagedTimestamp = 'N/A';
    if (data.engagedAt) {
      engagedTimestamp = new Date(data.engagedAt).toISOString();
    }

    // Extract parameters with explicit precedence
    const originalParams = data.original_params || {};

    const rowValues = [
      timestamp.toISOString(),
      data.phoneNumber || 'N/A',
      // UTM Source
      originalParams.CampaignSource || originalParams['Campaign Source'] || originalParams['Campaign_Source'] || originalParams.source || data.source || 'direct',
      // UTM Medium
      originalParams.AdSetName || originalParams['Ad Set Name'] || originalParams['Ad_Set_Name'] || originalParams.medium || data.medium || 'organic',
      // UTM Campaign
      originalParams.CampaignName || originalParams['Campaign Name'] || originalParams['Campaign_Name'] || originalParams.campaign || data.campaign || 'none',
      // UTM Content
      originalParams.AdName || originalParams['Ad Name'] || originalParams['Ad_Name'] || originalParams.content || data.content || 'none',
      // Placement
      originalParams.Placement || originalParams.placement || data.placement || 'N/A',
      data.hasEngaged ? '✅ YES' : '❌ NO',
      engagedTimestamp,
      data.attribution_source || 'unknown',
      data.contactId || 'N/A',
      data.conversationId || 'N/A',
      data.contactName || 'Anonymous',
      data.lastMessage ? data.lastMessage.substring(0, 150).replace(/\n/g, ' ') : 'No text content'
    ];

    return rowValues;
  });
}

async function syncToSheets() {
  const SPREADSHEET_ID = process.env.SHEETS_SPREADSHEET_ID || '1TCoSBJdG3guTxw68LSvAiONxmeP_SFjQb4BfdSmpIXE';
  const SHEET_NAME = 'Sheet1';
  const MAX_RETRIES = 3;
  let attempt = 0;

  console.log(`🔄 Starting sync (Attempt ${attempt + 1}/${MAX_RETRIES})`);

  while (attempt < MAX_RETRIES) {
    try {
      const sheetsClient = await initializeSheetsClient();

      // 1. Get spreadsheet metadata and verify sheet exists
      const { data: spreadsheet } = await sheetsClient.spreadsheets.get({
        spreadsheetId: SPREADSHEET_ID,
        includeGridData: false
      });

      console.log(`✅ Accessing spreadsheet: "${spreadsheet.properties.title}"`);

      // 2. Check if sheet exists
      const sheetExists = spreadsheet.sheets?.some(s => s.properties?.title === SHEET_NAME);

      // 3. Create sheet if it doesn't exist
      if (!sheetExists) {
        console.log(`🔄 Creating new sheet: ${SHEET_NAME}`);
        await sheetsClient.spreadsheets.batchUpdate({
          spreadsheetId: SPREADSHEET_ID,
          resource: {
            requests: [{
              addSheet: {
                properties: {
                  title: SHEET_NAME,
                  gridProperties: {
                    rowCount: 1000,
                    columnCount: 14
                  }
                }
              }
            }]
          }
        });
      }

      // 4. Now handle headers
      const { data: sheetsData } = await sheetsClient.spreadsheets.values.get({
        spreadsheetId: SPREADSHEET_ID,
        range: `${SHEET_NAME}!A1:N1`
      });

      const requiredHeaders = [
        'Timestamp', 'Phone Number', 'UTM Source', 'UTM Medium',
        'UTM Campaign', 'UTM Content', 'Placement', 'Engaged',
        'Engaged At', 'Attribution Source', 'Contact ID',
        'Conversation ID', 'Contact Name', 'Last Message'
      ];

      if (!sheetsData.values || !sheetsData.values[0]) {
        console.log('⏳ Setting up headers');
        await sheetsClient.spreadsheets.values.update({
          spreadsheetId: SPREADSHEET_ID,
          range: `${SHEET_NAME}!A1:N1`,
          valueInputOption: 'RAW',
          resource: { values: [requiredHeaders] }
        });
      }

      // Query MongoDB for documents to sync
      const documents = await UtmClick.find({
        hasEngaged: true,
        syncedToSheets: false,
        source: { $ne: 'direct_message' }
      })
      .sort({ timestamp: -1 })
      .limit(250);

      if (documents.length === 0) {
        console.log('ℹ️ No new records to sync');
        return { count: 0 };
      }

      console.log(`🔍 Found ${documents.length} documents to sync`);
      const rows = convertToSheetRows(documents);

      // Append to sheets FIRST (before marking as synced)
      const appendResponse = await sheetsClient.spreadsheets.values.append({
        spreadsheetId: SPREADSHEET_ID,
        range: `${SHEET_NAME}!A:N`,
        valueInputOption: 'USER_ENTERED',
        insertDataOption: 'INSERT_ROWS',
        resource: { values: rows }
      });

      console.log('📊 Sheets update:', appendResponse.data.updates.updatedRange);

      // THEN mark as synced (only after successful sheets write)
      const updatePromises = documents.map(doc => {
        return UtmClick.findByIdAndUpdate(doc._id, {
          syncedToSheets: true,
          lastSynced: new Date()
        });
      });

      await Promise.all(updatePromises);
      console.log('✅ MongoDB documents updated');

      return {
        count: rows.length,
        spreadsheetId: SPREADSHEET_ID,
        sheetName: SHEET_NAME
      };

    } catch (err) {
      attempt++;
      console.error(`❌ Attempt ${attempt} failed:`, err.message);

      if (attempt >= MAX_RETRIES) {
        console.error('💥 Maximum retries exceeded');
        throw new Error(`Final sync failure: ${err.message}`);
      }

      await new Promise(resolve => setTimeout(resolve, attempt * 2000));
    }
  }
}

async function scheduledSync() {
  const startTime = Date.now();
  const result = {
    success: false,
    duration: 0,
    syncedCount: 0
  };

  try {
    const syncResult = await syncToSheets();
    result.success = true;
    result.syncedCount = syncResult.count;
    result.duration = Date.now() - startTime;
    result.spreadsheetId = syncResult.spreadsheetId;
  } catch (err) {
    result.error = err.message;
    result.retryable = err.message.includes('quota') || err.code === 429;
  } finally {
    result.timestamp = new Date().toISOString();
    console.log('⏱️ Sync result:', result);
    return result;
  }
}

// Real-time sync using MongoDB Change Streams
async function setupRealtimeSync() {
  console.log('🔄 Setting up real-time MongoDB to Sheets sync');
  
  try {
    // Create change stream for monitoring new engaged messages
    const changeStream = UtmClick.watch([
      {
        $match: {
          $and: [
            { 'fullDocument.hasEngaged': true },
            { 'fullDocument.syncedToSheets': false },
            { 'fullDocument.source': { $ne: 'direct_message' } }
          ]
        }
      }
    ]);
    
    // Set up the listener
    changeStream.on('change', async (change) => {
      try {
        // Only process insert and update operations
        if (change.operationType !== 'insert' && change.operationType !== 'update') {
          return;
        }
        
        const doc = change.fullDocument;
        if (!doc) return;
        
        console.log(`🔥 Real-time sync triggered for document: ${doc._id}`);
        
        // Initialize the sheets client
        const sheetsClient = await initializeSheetsClient();
        const SPREADSHEET_ID = process.env.SHEETS_SPREADSHEET_ID || '1TCoSBJdG3guTxw68LSvAiONxmeP_SFjQb4BfdSmpIXE';
        const SHEET_NAME = 'Sheet1';
        
        // Convert the document to sheet row
        const rows = convertToSheetRows([doc]);
        
        // Append to sheets FIRST
        const appendResponse = await sheetsClient.spreadsheets.values.append({
          spreadsheetId: SPREADSHEET_ID,
          range: `${SHEET_NAME}!A:N`,
          valueInputOption: 'USER_ENTERED',
          insertDataOption: 'INSERT_ROWS',
          resource: { values: rows }
        });
        
        console.log('📊 Sheets update:', appendResponse.data.updates.updatedRange);
        
        // THEN mark as synced
        await UtmClick.findByIdAndUpdate(doc._id, {
          syncedToSheets: true,
          lastSynced: new Date()
        });
        
        console.log('✅ Real-time sync completed');
        
      } catch (err) {
        console.error('❌ Real-time sync error:', err);
      }
    });
    
    changeStream.on('error', (error) => {
      console.error('🚨 Change stream error:', error);
      // Attempt to recreate the listener after a delay
      setTimeout(() => setupRealtimeSync(), 60000);
    });
    
    // Return cleanup function
    return () => {
      console.log('🛑 Closing change stream');
      changeStream.close();
    };
    
  } catch (err) {
    console.error('💥 Failed to set up real-time sync:', err);
    // Attempt to recreate the listener after a delay
    setTimeout(() => setupRealtimeSync(), 60000);
  }
}

module.exports = { syncToSheets, scheduledSync, setupRealtimeSync };
