import { User } from "../models/User.js";

/** Must run after authMiddleware. Driver account with isAdmin on the user document. */
export async function requireDriverAdmin(req, res, next) {
  if (req.userRole !== "driver") {
    res.status(403).json({ error: "Admin tools require a driver account" });
    return;
  }
  const user = await User.findById(req.userId).select("isAdmin").lean().exec();
  if (!user?.isAdmin) {
    res.status(403).json({ error: "Forbidden" });
    return;
  }
  next();
}
