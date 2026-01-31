const mongoose = require('mongoose');

// MongoDB Connection
const connectDB = async () => {
  try {
    const conn = await mongoose.connect(process.env.MONGODB_URI, {
      serverSelectionTimeoutMS: 5000,
      socketTimeoutMS: 45000,
    });
    
    console.log(`✅ MongoDB Connected: ${conn.connection.host}`);
    return conn;
  } catch (error) {
    console.error('❌ MongoDB Connection Error:', error.message);
    // Retry connection after 5 seconds
    setTimeout(connectDB, 5000);
  }
};

// UTM Click Schema - matches your Firestore structure
const utmClickSchema = new mongoose.Schema({
  // Session ID is stored as _id in MongoDB (same as Firestore doc ID)
  
  // UTM Parameters
  source: { type: String, default: 'direct_message' },
  medium: { type: String, default: 'whatsapp' },
  campaign: { type: String, default: 'organic' },
  content: { type: String, default: 'none' },
  placement: { type: String, default: 'N/A' },
  
  // Original parameters (preserves all URL params)
  original_params: { type: mongoose.Schema.Types.Mixed, default: {} },
  
  // Engagement tracking
  hasEngaged: { type: Boolean, default: false },
  phoneNumber: { type: String, default: null },
  
  // Gallabox identifiers
  contactId: { type: String, default: null },
  conversationId: { type: String, default: null },
  contactName: { type: String, default: null },
  lastMessage: { type: String, default: null },
  
  // Attribution
  attribution_source: { type: String, default: 'unknown' },
  
  // Timestamps
  timestamp: { type: Date, default: Date.now },
  click_time: { type: Date, default: Date.now },
  engagedAt: { type: Date, default: null },
  
  // Sync tracking
  syncedToSheets: { type: Boolean, default: false },
  lastSynced: { type: Date, default: null },
  
  // Additional metadata
  full_url: { type: String, default: null },
}, {
  timestamps: true, // Adds createdAt and updatedAt automatically
  collection: 'utmClicks'
});

// Indexes for fast queries
utmClickSchema.index({ phoneNumber: 1, hasEngaged: 1, timestamp: -1 });
utmClickSchema.index({ contactId: 1 });
utmClickSchema.index({ conversationId: 1 });
utmClickSchema.index({ hasEngaged: 1, syncedToSheets: 1, source: 1 });
utmClickSchema.index({ timestamp: -1 });

const UtmClick = mongoose.model('UtmClick', utmClickSchema);

module.exports = { connectDB, UtmClick };
