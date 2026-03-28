const express = require("express");
const https = require("https");
const app = express();

app.use(express.json());

const BOT_TOKEN = process.env.BOT_TOKEN;
const CHAT_ID = process.env.CHAT_ID;
const GH_TOKEN = process.env.GH_TOKEN;
const SECRET = process.env.CRON_SECRET;
const BC_TOKEN = process.env.BC_ACCESS_TOKEN;
const BC_ACCOUNT = process.env.BC_ACCOUNT_ID;
const BC_EMAIL = process.env.BC_USER_EMAIL;

function sendTelegram(text, extra = {}) {
  return new Promise((resolve, reject) => {
    const payload = { chat_id: CHAT_ID, text: text, parse_mode: "HTML", ...extra };
    const data = JSON.stringify(payload);
    const req = https.request({
      hostname: "api.telegram.org",
      path: "/bot" + BOT_TOKEN + "/sendMessage",
      method: "POST",
      headers: { "Content-Type": "application/json" }
    }, res => { let d = ""; res.on("data", c => d += c); res.on("end", () => resolve(d)); });
    req.on("error", reject);
    req.write(data);
    req.end();
  });
}

function ghAPI(path, method = "GET", body = null) {
  return new Promise((resolve, reject) => {
    const options = {
      hostname: "api.github.com",
      path: path,
      method: method,
      headers: {
        "Authorization": "Bearer " + GH_TOKEN,
        "User-Agent": "openclaw-notifier",
        "Accept": "application/vnd.github+json"
      }
    };
    if (body) options.headers["Content-Length"] = Buffer.byteLength(JSON.stringify(body));

    const req = https.request(options, res => {
      let d = "";
      res.on("data", c => d += c);
      res.on("end", () => {
        try { resolve(d ? JSON.parse(d) : {}); } catch (e) { resolve({}); }
      });
    });
    req.on("error", reject);
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

function bcAPI(path, method = "GET", body = null) {
  return new Promise((resolve, reject) => {
    const options = {
      hostname: "3.basecampapi.com",
      path: "/" + BC_ACCOUNT + path,
      method: method,
      headers: {
        "Authorization": "Bearer " + BC_TOKEN,
        "User-Agent": "FoodXp Bot (" + BC_EMAIL + ")",
        "Accept": "application/json"
      }
    };
    if (body) {
      options.headers["Content-Type"] = "application/json";
      options.headers["Content-Length"] = Buffer.byteLength(JSON.stringify(body));
    }
    const req = https.request(options, res => {
      let d = "";
      res.on("data", c => d += c);
      res.on("end", () => {
        if (res.statusCode >= 400) {
          console.error("Basecamp API Error (" + res.statusCode + "): " + d);
          resolve({ error: res.statusCode, message: d });
        } else {
          try { resolve(d ? JSON.parse(d) : []); } catch (e) { resolve([]); }
        }
      });
    });
    req.on("error", reject);
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

app.get("/", (req, res) => res.send("OK"));

// Telegram webhook - handles user replies
app.post("/webhook", async (req, res) => {
  try {
    const message = req.body && req.body.message;
    const callback = req.body && req.body.callback_query;

    // Handle Callback Queries (Buttons)
    if (callback) {
      const data = callback.data;
      const chatId = String(callback.message.chat.id);
      if (chatId !== CHAT_ID) return res.send("OK");

      // Step 2: Project selected -> Show PRs
      if (data.startsWith("rv_p:")) {
        const projectId = data.split(":")[1];
        const prs = await ghAPI("/repos/travelxp/foodxp-cms/pulls?state=open");
        const myPRs = prs.filter(p => p.user.login === "AnishTxp");
        
        if (myPRs.length === 0) {
          await sendTelegram("No open PRs found to review.");
          return res.send("OK");
        }

        const buttons = myPRs.map(p => ([{ text: "PR #" + p.number + ": " + p.title.substring(0, 30), callback_data: "rv_s:" + projectId + ":" + p.number }]));
        await sendTelegram("Selected Project: " + projectId + "\n\nSelect a PR to share:", {
          reply_markup: { inline_keyboard: buttons }
        });
      }

      // Step 3: PR selected -> Post to Basecamp
      if (data.startsWith("rv_s:")) {
        const [_, pId, prNum] = data.split(":");
        const pr = await ghAPI("/repos/travelxp/foodxp-cms/pulls/" + prNum);
        
        // Find Campfire ID
        const project = await bcAPI("/buckets/" + pId + ".json");
        const campfireTool = project.dock.find(t => t.name === "chat" || t.title === "Campfire");
        
        if (!campfireTool) {
          await sendTelegram("❌ Could not find a Campfire chat for this project.");
          return res.send("OK");
        }

        const chatIdBC = campfireTool.url.split("/").pop().replace(".json", "");
        const msgText = pr.html_url + " 🌳 Dhruv sir please review this PR";
        
        await bcAPI("/buckets/" + pId + "/chats/" + chatIdBC + "/lines.json", "POST", { content: msgText });
        await sendTelegram("✅ Posted to Basecamp Campfire!");
      }

      // GH Step: Repo selected -> Show Issues
      if (data.startsWith("gh_r:")) {
        const repo = data.split(":")[1];
        const issues = await ghAPI("/repos/travelxp/" + repo + "/issues?state=open");
        const filtered = Array.isArray(issues) ? issues.filter(i => !i.pull_request).slice(0, 15) : [];
        if (filtered.length === 0) return await sendTelegram("No open issues in " + repo);
        const list = filtered.map(i => "• #" + i.number + " — " + i.title).join("\n");
        const buttons = [[{ text: "👁️ View Closed", callback_data: "cd_rl:" + repo + ":closed" }]];
        await sendTelegram("📂 <b>" + repo + "</b> Issues:\n\n" + list, { reply_markup: { inline_keyboard: buttons } });
      }

      // CODE FLOW: Root Menu
      if (data === "cd_root") {
        const buttons = [
          [{ text: "👤 Issues Assigned to Me", callback_data: "cd_asgn:open" }],
          [{ text: "📦 Select Repository", callback_data: "cd_r_list" }]
        ];
        await sendTelegram("🤖 <b>OpenClaw Agent</b>\nWhere would you like to start coding?", { reply_markup: { inline_keyboard: buttons } });
      }

      // CODE FLOW: Assigned issues (Open or Closed)
      if (data.startsWith("cd_asgn:")) {
        const state = data.split(":")[1];
        const issues = await ghAPI("/repos/travelxp/foodxp-cms/issues?assignee=AnishTxp&state=" + state);
        const filtered = issues.filter(i => !i.pull_request).slice(0, 10);
        const buttons = filtered.map(i => ([{ text: "#" + i.number + ": " + i.title.substring(0, 30), callback_data: "cd_sel:foodxp-cms:" + i.number }]));
        buttons.push([{ text: (state === "open" ? "👁️ View Closed" : "👁️ View Open"), callback_data: "cd_asgn:" + (state === "open" ? "closed" : "open") }]);
        buttons.push([{ text: "🔙 Back", callback_data: "cd_root" }]);
        await sendTelegram("📋 <b>" + (state === "open" ? "Open" : "Closed") + " Issues (Assigned):</b>", { reply_markup: { inline_keyboard: buttons } });
      }

      // CODE FLOW: Repo list
      if (data === "cd_r_list") {
        const repos = ["foodxp-cms", "foodxp-b2c-service", "foodxp-mongodb"];
        const buttons = repos.map(r => ([{ text: "📁 " + r, callback_data: "cd_rl:" + r + ":open" }]));
        buttons.push([{ text: "🔙 Back", callback_data: "cd_root" }]);
        await sendTelegram("Select a repository to explore issues:", { reply_markup: { inline_keyboard: buttons } });
      }

      // CODE FLOW: Repo Issues list
      if (data.startsWith("cd_rl:")) {
        const [_, repo, state] = data.split(":");
        const issues = await ghAPI("/repos/travelxp/" + repo + "/issues?state=" + state);
        const filtered = Array.isArray(issues) ? issues.filter(i => !i.pull_request).slice(0, 10) : [];
        const buttons = filtered.map(i => ([{ text: "#" + i.number + ": " + i.title.substring(0, 30), callback_data: "cd_sel:" + repo + ":" + i.number }]));
        buttons.push([{ text: (state === "open" ? "👁️ View Closed" : "👁️ View Open"), callback_data: "cd_rl:" + repo + ":" + (state === "open" ? "closed" : "open") }]);
        buttons.push([{ text: "🔙 Repository List", callback_data: "cd_r_list" }]);
        await sendTelegram("📂 <b>" + repo + "</b> (" + state + "):", { reply_markup: { inline_keyboard: buttons } });
      }

      // CODE FLOW: Selected Issue -> Show Start Button
      if (data.startsWith("cd_sel:")) {
        const [_, repo, num] = data.split(":");
        const buttons = [[{ text: "🚀 Start AI Coding Agent", callback_data: "cd_run:" + repo + ":" + num }]];
        buttons.push([{ text: "🔙 Back to List", callback_data: "cd_root" }]);
        await sendTelegram("Issue <code>#" + num + "</code> selected from <code>" + repo + "</code>.\nReady to start the OpenClaw agent?", { reply_markup: { inline_keyboard: buttons } });
      }

      // CODE FLOW: RUN
      if (data.startsWith("cd_run:")) {
        const [_, repo, num] = data.split(":");
        await sendTelegram("🤖 Starting <b>OpenClaw Agent</b> for " + repo + " #" + num + "...\n(Tracking progress live)");
        
        const payload = { ref: "main", inputs: { issue_number: num } };
        // Dispatch to the specific repository selected
        await ghAPI("/repos/travelxp/" + repo + "/actions/workflows/openclaw.yml/dispatches", "POST", payload);
        await sendTelegram("✅ Dispatch successful. Monitor logs on GitHub Actions.");
      }

      // MB Step 2: Project selected -> Show Closed PRs
      if (data.startsWith("mb_p:")) {
        const pId = data.split(":")[1];
        const prs = await ghAPI("/repos/travelxp/foodxp-cms/pulls?state=closed&per_page=10");
        const myClosedPRs = prs.filter(p => p.user.login === "AnishTxp" && p.merged_at);
        
        if (myClosedPRs.length === 0) {
          await sendTelegram("No recently merged PRs found.");
          return res.send("OK");
        }

        const buttons = myClosedPRs.map(p => ([{ text: "PR #" + p.number + ": " + p.title.substring(0, 30), callback_data: "mb_s:" + pId + ":" + p.number }]));
        await sendTelegram("Select a Merged PR to log on Message Board:", {
          reply_markup: { inline_keyboard: buttons }
        });
      }

      if (data.startsWith("mb_s:")) {
        const [_, pId, prNum] = data.split(":");
        const pr = await ghAPI("/repos/travelxp/foodxp-cms/pulls/" + prNum);
        
        const project = await bcAPI("/buckets/" + pId + ".json");
        const mbTool = project.dock.find(t => t.name === "message_board");
        
        if (!mbTool) {
          await sendTelegram("❌ Message Board not found in this project.");
          return res.send("OK");
        }

        const mbId = mbTool.url.split("/").pop().replace(".json", "");
        const points = pr.body ? pr.body.split("\n").filter(l => l.trim().startsWith("-")).map(l => "<li>" + l.replace("-", "").trim() + "</li>").join("") : "<li>No details.</li>";
        const bodyContent = "<div><strong>What Changed</strong><br/>" 
          + "<ul>" + points + "</ul>"
          + "<br/><a href=\"" + pr.html_url + "\">" + pr.html_url + "</a><br/>🚀</div>";

        await bcAPI("/buckets/" + pId + "/message_boards/" + mbId + "/messages.json", "POST", {
          subject: (pr.base.ref === "master" || pr.base.ref === "main" ? "Master " : "") + "PR#" + pr.number,
          content: bodyContent
        });
        
        await sendTelegram("✅ Successfully updated the " + project.name + " Message Board!");
      }

      // PR FLOW: Show PRs by state
      if (data.startsWith("pr_v:")) {
        const state = data.split(":")[1];
        const prs = await ghAPI("/repos/travelxp/foodxp-cms/pulls?state=" + state + "&per_page=15");
        const myPRs = prs.filter(p => p.user.login === "AnishTxp");
        
        if (myPRs.length === 0) {
          await sendTelegram("No " + state + " PRs found.");
          return res.send("OK");
        }

        const list = myPRs.map(p => "• PR #" + p.number + " — " + p.title + "\n  " + p.html_url).join("\n");
        const buttons = [[{ text: (state === "open" ? "📂 View Closed" : "📂 View Open"), callback_data: "pr_v:" + (state === "open" ? "closed" : "open") }]];
        await sendTelegram("🔀 <b>" + (state === "open" ? "Open" : "Closed") + " PRs (Assigned):</b>\n\n" + list, { reply_markup: { inline_keyboard: buttons } });
      }
      return res.send("OK");
    }

    if (!message || !message.text) return res.send("OK");
    const chatId = String(message.chat.id);
    if (chatId !== CHAT_ID) return res.send("OK");
    const text = message.text.trim();

    const helpMsg = "🚀 <b>OpenClaw AI & Notifier Dashboard</b>\n\n"
      + "<b>🤖 AI AGENT (OpenClaw)</b>\n"
      + "• /code — start the interactive AI coding menu\n"
      + "• Send #286 — view the full task description\n\n"
      + "<b>🍱 GITHUB TOOLS</b>\n"
      + "• /issues — list issues by repository\n"
      + "• /issues_assigned — view your tickets\n"
      + "• /prs — view your open/closed pulls\n\n"
      + "<b>🏕️ BASECAMP TOOLS</b>\n"
      + "• /review — post PR request to Campfire\n"
      + "• /update_message_board — log PR changes\n"
      + "• /bc_todos — view your active tasks\n\n"
      + "<i>Type /help anytime to see this menu.</i>";

    // Handle /start and /help
    if (text === "/start" || text === "/help") {
      await sendTelegram(helpMsg);
      return res.send("OK");
    }

    // Handle /issues (Repo selection)
    if (text === "/issues") {
      const repos = ["foodxp-cms", "foodxp-b2c-service", "foodxp-mongodb"];
      const buttons = repos.map(r => ([{ text: "📁 " + r, callback_data: "gh_r:" + r }]));
      await sendTelegram("Select a repository to view open issues:", {
        reply_markup: { inline_keyboard: buttons }
      });
      return res.send("OK");
    }

    // Handle /issues_assigned
    if (text === "/issues_assigned" || text === "/issues-assigned-to-me") {
      const issues = await ghAPI("/repos/travelxp/foodxp-cms/issues?assignee=AnishTxp&state=open");
      const filtered = issues.filter(i => !i.pull_request);
      if (filtered.length === 0) {
        await sendTelegram("No open issues assigned to you.");
        return res.send("OK");
      }
      const list = filtered.map(i => {
        const labels = i.labels.map(l => l.name).join(", ");
        return "• #" + i.number + " — " + i.title + (labels ? " [" + labels + "]" : "");
      }).join("\n");
      await sendTelegram("📋 " + filtered.length + " issues assigned to you:\n\n" + list + "\n\nSend #number for details.");
      return res.send("OK");
    }

    // Handle /issues <repo>
    if (text.startsWith("/issues ")) {
      let repo = text.split(" ")[1];
      if (!repo.includes("/")) repo = "travelxp/" + repo;
      
      const issues = await ghAPI("/repos/" + repo + "/issues?state=open");
      if (issues.message === "Not Found") {
        await sendTelegram("Repository <code>" + repo + "</code> not found.");
        return res.send("OK");
      }
      
      const filtered = Array.isArray(issues) ? issues.filter(i => !i.pull_request).slice(0, 15) : [];
      if (filtered.length === 0) {
        await sendTelegram("No open issues found in " + repo);
        return res.send("OK");
      }
      
      const list = filtered.map(i => "• #" + i.number + " — " + i.title).join("\n");
      await sendTelegram("📂 <b>" + repo + "</b> Issues:\n\n" + list + (issues.length > 15 ? "\n\n<i>Showing top 15...</i>" : ""));
      return res.send("OK");
    }

    // Handle /prs (Interactive)
    if (text === "/prs") {
      const buttons = [
        [{ text: "📂 View Open PRs", callback_data: "pr_v:open" }],
        [{ text: "📁 View Closed PRs", callback_data: "pr_v:closed" }]
      ];
      await sendTelegram("🔀 <b>GitHub Pull Requests</b>\nSelect the status you'd like to view:", {
        reply_markup: { inline_keyboard: buttons }
      });
      return res.send("OK");
    }

    // Handle /bc_todos
    if (text === "/bc_todos") {
      if (!BC_TOKEN) return await sendTelegram("Basecamp Token not configured on Render.");
      const todos = await bcAPI("/my/todos.json");
      if (todos.error) return await sendTelegram("❌ <b>Basecamp Error:</b> " + todos.error + "\nCheck your Token and ID.");
      if (!Array.isArray(todos) || todos.length === 0) {
        await sendTelegram("✅ No pending Basecamp to-dos!");
        return res.send("OK");
      }
      const list = todos.slice(0, 10).map(t => "• " + t.content + " (Project: " + t.bucket.name + ")").join("\n");
      await sendTelegram("📝 <b>Current Basecamp To-Dos:</b>\n\n" + list + (todos.length > 10 ? "\n\n<i>Showing top 10...</i>" : ""));
      return res.send("OK");
    }

    // Handle /review
    if (text === "/review") {
      const projects = await bcAPI("/projects.json");
      if (projects.error) return await sendTelegram("❌ <b>Basecamp Error:</b> " + projects.error + " (Forbidden/Unauthorized)");
      if (!Array.isArray(projects) || projects.length === 0) return await sendTelegram("No Basecamp projects found.");
      
      const buttons = projects.slice(0, 10).map(p => ([{ text: p.name, callback_data: "rv_p:" + p.id }]));
      await sendTelegram("📂 Select a Basecamp project/group to post review request:", {
        reply_markup: { inline_keyboard: buttons }
      });
      return res.send("OK");
    }

    // Handle /update_message_board
    if (text === "/update_message_board") {
      const projects = await bcAPI("/projects.json");
      if (projects.error) return await sendTelegram("❌ <b>Basecamp Error:</b> " + projects.error);
      if (!Array.isArray(projects) || projects.length === 0) return await sendTelegram("No Basecamp projects found.");

      const buttons = projects.slice(0, 10).map(p => ([{ text: p.name, callback_data: "mb_p:" + p.id }]));
      await sendTelegram("🗂 Select project to update Message Board:", {
        reply_markup: { inline_keyboard: buttons }
      });
      return res.send("OK");
    }

    // Handle issue number (#123 or just 123)
    const issueMatch = text.match(/#?(\d+)/);
    if (issueMatch) {
      const issueNum = issueMatch[1];
      const issue = await ghAPI("/repos/travelxp/foodxp-cms/issues/" + issueNum);

      if (issue.message === "Not Found") {
        await sendTelegram("Issue #" + issueNum + " not found.");
        return res.send("OK");
      }

      const labels = issue.labels ? issue.labels.map(l => l.name).join(", ") : "none";
      const assignees = issue.assignees ? issue.assignees.map(a => a.login).join(", ") : "none";
      const body = issue.body || "No description provided.";
      const isPR = issue.pull_request ? "🔀 Pull Request" : "📋 Issue";

      const msg = isPR + " #" + issueNum + "\n\n"
        + "<b>" + issue.title + "</b>\n\n"
        + "State: " + issue.state + "\n"
        + "Labels: " + labels + "\n"
        + "Assignees: " + assignees + "\n"
        + "Created: " + new Date(issue.created_at).toLocaleDateString("en-US", { timeZone: "Asia/Kolkata" }) + "\n\n"
        + body + "\n\n"
        + "🔗 " + issue.html_url;

      await sendTelegram(msg);
      return res.send("OK");
    }

    // Handle /code (Interactive flow)
    if (text === "/code") {
      const buttons = [
        [{ text: "👤 Issues Assigned to Me", callback_data: "cd_asgn:open" }],
        [{ text: "📦 Select Repository", callback_data: "cd_r_list" }]
      ];
      await sendTelegram("🤖 <b>OpenClaw Agent Builder</b>\nSelect an option to start coding:", {
        reply_markup: { inline_keyboard: buttons }
      });
      return res.send("OK");
    }

    await sendTelegram("I didn't understand that. Send #number for issue details, /code number to start AI coding, or /help for commands.");
    return res.send("OK");
  } catch (e) {
    console.error(e);
    return res.send("OK");
  }
});

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
    const message = "🍳 Morning Issue Digest\n📅 " + date + "\n📋 " + filtered.length + " open issues assigned to you:\n\n" + list + "\n\nSend #number for details.";
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
    /* In server.js */
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

// Register webhook on startup
const PORT = process.env.PORT || 3000;
app.listen(PORT, async () => {
  console.log("Server running on port " + PORT);
  // Set Telegram webhook
  const webhookUrl = process.env.RENDER_EXTERNAL_URL || process.env.BASE_URL;
  if (webhookUrl) {
    const url = "https://api.telegram.org/bot" + BOT_TOKEN + "/setWebhook?url=" + encodeURIComponent(webhookUrl + "/webhook");
    https.get(url, res => {
      let d = "";
      res.on("data", c => d += c);
      res.on("end", () => console.log("Webhook set:", d));
    });
  }
});
