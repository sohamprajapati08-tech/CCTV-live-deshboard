import mongoose from "mongoose";

const userSchema = new mongoose.Schema({
  email: { type: String, required: true, unique: true, lowercase: true, trim: true },
  passwordHash: { type: String, required: true },
  createdAt: { type: Date, default: Date.now }
});

const deviceSchema = new mongoose.Schema({
  ownerId: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true, index: true },
  name: { type: String, required: true, trim: true, maxlength: 60 },
  deviceType: { type: String, default: "Mobile browser" },
  browser: { type: String, default: "Unknown browser" },
  permissions: {
    camera: { type: Boolean, default: false },
    microphone: { type: Boolean, default: false }
  },
  battery: { level: Number, charging: Boolean },
  connectedAt: Date,
  lastSeenAt: Date,
  createdAt: { type: Date, default: Date.now }
});

const pairingSchema = new mongoose.Schema({
  ownerId: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true, index: true },
  tokenHash: { type: String, required: true, unique: true },
  expiresAt: { type: Date, required: true, index: { expires: 0 } },
  consumedAt: Date
});

export const User = mongoose.model("User", userSchema);
export const Device = mongoose.model("Device", deviceSchema);
export const Pairing = mongoose.model("Pairing", pairingSchema);
