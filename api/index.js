const express = require("express");
const mongoose = require("mongoose");
const cookieParser = require("cookie-parser");
const dotenv = require("dotenv");
const jwt = require("jsonwebtoken");
const cors = require("cors");
const bcrypt = require("bcryptjs");
const User = require("./models/User");
const Message = require("./models/Message");
const ws = require("ws");
const fs = require("fs");
const OpenAI = require("openai");
const Context = require("./models/Context");

dotenv.config();
mongoose.set("strictQuery", true);
mongoose.connect(process.env.MONGO_URL, (err) => {
	if (err) throw err;
});
const jwtSecret = process.env.JWT_SECRET;
const bcryptSalt = bcrypt.genSaltSync(10);

const app = express();
app.use("/uploads", express.static(__dirname + "/uploads"));
app.use(express.json());
app.use(cookieParser());
app.use(
	cors({
		credentials: true,
		origin: process.env.CLIENT_URL,
	})
);

// Config OpenAI
const openai = new OpenAI({
	apiKey: process.env.OPENAI_API_KEY,
});

app.get("/openai", async (req, res) => {
	try {
		const { prompt } = req.body;
		const aiResponse = await openai.chat.completions.create({
			model: "gpt-3.5-turbo",
			temperature: 0.8,
			messages: [{ content: prompt, role: "user" }],
		});
		res.json({
			ai_response: aiResponse.choices[0].message,
		});
	} catch (err) {
		console.error(err);
		res.status(500).json(err);
	}
});

async function getUserDataFromRequest(req) {
	return new Promise((resolve, reject) => {
		const token = req.cookies?.token;
		if (token) {
			jwt.verify(token, jwtSecret, {}, (err, userData) => {
				if (err) throw err;
				resolve(userData);
			});
		} else {
			reject("no token");
		}
	});
}

app.get("/test", (req, res) => {
	res.json("test ok");
});

app.get("/messages/:userId", async (req, res) => {
	const { userId } = req.params;
	const userData = await getUserDataFromRequest(req);
	const ourUserId = userData.userId;
	const messages = await Message.find({
		sender: { $in: [userId, ourUserId] },
		recipient: { $in: [userId, ourUserId] },
	}).sort({ createdAt: 1 });
	res.json(messages);
});

app.get("/people", async (req, res) => {
	const users = await User.find({}, { _id: 1, username: 1 });
	res.json(users);
});

app.get("/profile", (req, res) => {
	const token = req.cookies?.token;
	if (token) {
		jwt.verify(token, jwtSecret, {}, (err, userData) => {
			if (err) throw err;
			res.json(userData);
		});
	} else {
		res.status(401).json("no token");
	}
});

app.post("/login", async (req, res) => {
	const { username, password } = req.body;
	const foundUser = await User.findOne({ username });
	if (foundUser) {
		const passOk = bcrypt.compareSync(password, foundUser.password);
		if (passOk) {
			jwt.sign(
				{ userId: foundUser._id, username },
				jwtSecret,
				{},
				(err, token) => {
					res.cookie("token", token, {
						sameSite: "none",
						secure: true,
					}).json({
						id: foundUser._id,
					});
				}
			);
		}
	}
});

app.post("/logout", (req, res) => {
	res.cookie("token", "", { sameSite: "none", secure: true }).json("ok");
});

app.post("/register", async (req, res) => {
	const { username, password, language } = req.body;
	try {
		const hashedPassword = bcrypt.hashSync(password, bcryptSalt);
		const createdUser = await User.create({
			username: username,
			password: hashedPassword,
			language: language,
		});
		jwt.sign(
			{ userId: createdUser._id, username },
			jwtSecret,
			{},
			(err, token) => {
				if (err) throw err;
				res.cookie("token", token, { sameSite: "none", secure: true })
					.status(201)
					.json({
						id: createdUser._id,
					});
			}
		);
	} catch (err) {
		if (err) throw err;
		res.status(500).json("error");
	}
});

app.post("/setContext", async (req, res) => {
	const { context, recipient } = req.body;
	const userData = await getUserDataFromRequest(req);
	const ourUserId = userData.userId;
	const contextDoc = await Context.create({
		sender: ourUserId,
		recipient,
		context,
	});
	res.json(contextDoc);
});

app.get("/getContext/:recipient", async (req, res) => {
	const { recipient } = req.params;
	const userData = await getUserDataFromRequest(req);
	const ourUserId = userData.userId;
	const contextDoc = await Context.findOne({
		sender: ourUserId,
		recipient,
	});
	res.json(contextDoc);
});

app.put("/updateContext/:recipient", async (req, res) => {
	const { recipient } = req.params;
	const { context } = req.body;
	const userData = await getUserDataFromRequest(req);
	const ourUserId = userData.userId;
	const contextDoc = await Context.findOneAndUpdate(
		{ sender: ourUserId, recipient },
		{ context }
	);
	res.json(contextDoc);
});

app.post("/rewriteMessage", async (req, res) => {
	const { recipient, message } = req.body;
	const userData = await getUserDataFromRequest(req);
	const ourUserId = userData.userId;
	const contextDoc = await Context.findOne({
		sender: ourUserId,
		recipient,
	});
	const context = contextDoc?.context || "";
	const messages = await Message.find({
		sender: { $in: [recipient, ourUserId] },
		recipient: { $in: [recipient, ourUserId] },
	}).sort({ createdAt: 1 });
	const messagesText = messages.map((m) => m.text).join("\n");

	const prompt = `This is the context of the conversation:${context}.These are some current messages:${messagesText}.Rewrite this message to fit the context:${message}.Only output the rewritten message.`;
	const aiResponse = await openai.chat.completions.create({
		model: "gpt-3.5-turbo",
		temperature: 0.8,
		messages: [{ content: prompt, role: "user" }],
	});
	const rewrittenMessage = aiResponse.choices[0].message;
	res.json({ rewrittenMessage });
});

app.post("/rewriteTranslation", async (req, res) => {
	const { recipient, message } = req.body;
	const userData = await getUserDataFromRequest(req);
	const ourUserId = userData.userId;
	const contextDoc = await Context.findOne({
		sender: ourUserId,
		recipient,
	});
	const recipientUser = await User.findById(recipient);
  const recipientLanguage = recipientUser?.language || "English";
	const context = contextDoc?.context || "";
	const messages = await Message.find({
		sender: { $in: [recipient, ourUserId] },
		recipient: { $in: [recipient, ourUserId] },
	}).sort({ createdAt: 1 });
	const messagesText = messages.map((m) => m.text).join("\n");
	const prompt = `This is the context of the conversation:${context}.These are some current messages:${messagesText}.Rewrite this message to fit the context using ${recipientLanguage} language:${message}.Only output the rewritten message.`;
	console.log(prompt);

	const aiResponse = await openai.chat.completions.create({
		model: "gpt-3.5-turbo",
		temperature: 0.8,
		messages: [{ content: prompt, role: "user" }],
	});

	const rewrittenMessage = aiResponse.choices[0].message;
	res.json({ rewrittenMessage });
});

const server = app.listen(4040);

const wss = new ws.WebSocketServer({ server });
wss.on("connection", (connection, req) => {
	function notifyAboutOnlinePeople() {
		[...wss.clients].forEach((client) => {
			client.send(
				JSON.stringify({
					online: [...wss.clients].map((c) => ({
						userId: c.userId,
						username: c.username,
					})),
				})
			);
		});
	}

	connection.isAlive = true;

	connection.timer = setInterval(() => {
		connection.ping();
		connection.deathTimer = setTimeout(() => {
			connection.isAlive = false;
			clearInterval(connection.timer);
			connection.terminate();
			notifyAboutOnlinePeople();
			console.log("dead");
		}, 1000);
	}, 5000);

	connection.on("pong", () => {
		clearTimeout(connection.deathTimer);
	});

	// read username and id from the cookie for this connection
	const cookies = req.headers.cookie;
	if (cookies) {
		const tokenCookieString = cookies
			.split(";")
			.find((str) => str.startsWith("token="));
		if (tokenCookieString) {
			const token = tokenCookieString.split("=")[1];
			if (token) {
				jwt.verify(token, jwtSecret, {}, (err, userData) => {
					if (err) throw err;
					const { userId, username } = userData;
					connection.userId = userId;
					connection.username = username;
				});
			}
		}
	}

	connection.on("message", async (message) => {
		const messageData = JSON.parse(message.toString());
		const { recipient, text, file } = messageData;
		let filename = null;
		if (file) {
			console.log("size", file.data.length);
			const parts = file.name.split(".");
			const ext = parts[parts.length - 1];
			filename = Date.now() + "." + ext;
			const path = __dirname + "/uploads/" + filename;
			const bufferData = new Buffer(file.data.split(",")[1], "base64");
			fs.writeFile(path, bufferData, () => {
				console.log("file saved:" + path);
			});
		}
		if (recipient && (text || file)) {
			const messageDoc = await Message.create({
				sender: connection.userId,
				recipient,
				text,
				file: file ? filename : null,
			});
			console.log("created message");
			[...wss.clients]
				.filter((c) => c.userId === recipient)
				.forEach((c) =>
					c.send(
						JSON.stringify({
							text,
							sender: connection.userId,
							recipient,
							file: file ? filename : null,
							_id: messageDoc._id,
						})
					)
				);
		}
	});

	// notify everyone about online people (when someone connects)
	notifyAboutOnlinePeople();
});
