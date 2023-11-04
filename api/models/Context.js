const mongoose = require("mongoose");

const ContextSchema = new mongoose.Schema(
	{
		sender: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
		recipient: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
		context: String,
	},
	{ timestamps: true }
);

const ContextModel = mongoose.model("Context", ContextSchema);

module.exports = ContextModel;
