import { Router } from "express";
import bcrypt from "bcryptjs";
import { User } from "../models/User.js";
import { signToken } from "../middleware/auth.js";

const r = Router();

r.post("/register", async (req, res) => {
  const { email, password, name, role } = req.body || {};
  if (!email || !password || !name || !role || !["rider", "driver"].includes(role)) {
    res.status(400).json({ error: "email, password, name, and role (rider|driver) required" });
    return;
  }
  const existing = await User.findOne({ email: email.toLowerCase() });
  if (existing) {
    res.status(409).json({ error: "Email already registered" });
    return;
  }
  const passwordHash = await bcrypt.hash(password, 10);
  const user = await User.create({
    email: email.toLowerCase(),
    passwordHash,
    name,
    role,
  });
  const token = signToken(String(user._id), user.role);
  res.status(201).json({
    token,
    user: {
      _id: String(user._id),
      email: user.email,
      name: user.name,
      role: user.role,
    },
  });
});

r.post("/login", async (req, res) => {
  const { email, password } = req.body || {};
  if (!email || !password) {
    res.status(400).json({ error: "email and password required" });
    return;
  }
  const user = await User.findOne({ email: email.toLowerCase() });
  if (!user || !(await bcrypt.compare(password, user.passwordHash))) {
    res.status(401).json({ error: "Invalid credentials" });
    return;
  }
  const token = signToken(String(user._id), user.role);
  res.json({
    token,
    user: {
      _id: String(user._id),
      email: user.email,
      name: user.name,
      role: user.role,
    },
  });
});

export const authRouter = r;
