const express = require("express");
const https = require("https");
const app = express();

const BOT_TOKEN = process.env.BOT_TOKEN;
const CHAT_ID = process.env.CHAT_ID;
const GH_TOKEN = process.env.GH_TOKEN;
const SECRET = process.env.CRON_SECRET;

function sendTelegram(text) {
  return new Promise((resolve, reject) => {
    const data = "chat_id=" + CHAT_ID + "&text=" + encodeURIComponent(text);
    const req = https.request({
      hostname: "api.telegram.org",
      path: "/bot" + BOT_TOKEN + "/sendMessage",
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" }
    }, res => { let d = ""; res.on("data", c => d += c); res.on("end", () => resolve(d)); });
    req.on("error", reject);
    req.write(data);
    req.end();
  });
}

function ghAPI(path) {
  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: "api.github.com",
      path: path,
      method: "GET",
      headers: {
        "Authorization": "Bearer " + GH_TOKEN,
        "User-Agent": "openclaw-notifier",
        "Accept": "application/vnd.github+json"
      }
    }, res => { let d = ""; res.on("data", c => d += c); res.on("end", () => resolve(JSON.parse(d))); });
    req.on("error", reject);
    req.end();
  });
}

app.get("/", (req, res) => res.send("OK"));

app.get("/digest", async (req, res) => {
  if (req.query.secret !== SECRET) return res.status(403).send("Forbidden");
  try {
    const issues = await ghAPI("/repos/travelxp/foodxp-cms/issues?assignee=AnishTxp&state=open");
    const filtered = issues.filter(i => !i.pull_request);
    if (filtered.length === 0) return res.send("No issues");
    const list = filtered.map(i => {
      const labels = i.labels.map(l => l.name).join(", ");
      return "• #" + i.number + " — " + i.title + " [" + labels + "]";
    }).join("\n");
    const date = new Date().toLocaleDateString("en-US", { weekday: "long", year: "numeric", month: "long", day: "numeric", timeZone: "Asia/Kolkata" });
    const message = "🍳 Morning Issue Digest\n📅 " + date + "\n📋 " + filtered.length + " open issues assigned to you:\n\n" + list + "\n\nReply with an issue number to see details.";
    await sendTelegram(message);
    res.send("Digest sent");
  } catch (e) { console.error(e); res.status(500).send(e.message); }
});

app.get("/pr-comments", async (req, res) => {
  if (req.query.secret !== SECRET) return res.status(403).send("Forbidden");
  try {
    const prs = await ghAPI("/repos/travelxp/foodxp-cms/pulls?state=open");
    const myPRs = prs.filter(p => p.user.login === "AnishTxp");
    if (myPRs.length === 0) return res.send("No open PRs");
    const since = new Date(Date.now() - 30 * 60 * 1000).toISOString();
    for (const pr of myPRs) {
      const comments = await ghAPI("/repos/travelxp/foodxp-cms/pulls/" + pr.number + "/comments");
      const reviews = await ghAPI("/repos/travelxp/foodxp-cms/pulls/" + pr.number + "/reviews");
      const newComments = comments.filter(c => c.created_at > since && c.user.login !== "AnishTxp").map(c => "💬 " + c.user.login + " on PR #" + pr.number + ":\n" + c.body);
      const newReviews = reviews.filter(r => r.submitted_at > since && r.user.login !== "AnishTxp" && r.body).map(r => "📝 " + r.user.login + " reviewed PR #" + pr.number + " (" + r.state + "):\n" + r.body);
      const all = [...newComments, ...newReviews];
      if (all.length > 0) {
        const message = "🔔 New PR Comments\n\n" + all.join("\n\n") + "\n\nOpen Claude Code to draft replies.";
        await sendTelegram(message);
      }
    }
    res.send("Check complete");
  } catch (e) { console.error(e); res.status(500).send(e.message); }
});

app.listen(process.env.PORT || 3000, () => console.log("Server running"));
