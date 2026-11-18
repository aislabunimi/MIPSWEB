// server.js
const express = require("express");
const path = require("path");

const app = express();
const PORT = parseInt(process.env.PORT, 10) || 8080;

app.use("/css", express.static(path.join(__dirname, "css")));
app.use("/js", express.static(path.join(__dirname, "js")));
app.use("/templates", express.static(path.join(__dirname, "src/templates")));
app.use("/projects", express.static(path.join(__dirname, "projects")));

// App configuration from the environment:
//   MIPSWEB_MODE=evaluator   enables the exam evaluator
//   MIPSWEB_MAX_STEPS=<n>    default max executed instructions per evaluator run (default 1000)
const config = {
  mode: process.env.MIPSWEB_MODE === "evaluator" ? "evaluator" : "normal",
  evaluatorMaxSteps: parseInt(process.env.MIPSWEB_MAX_STEPS, 10) > 0
    ? parseInt(process.env.MIPSWEB_MAX_STEPS, 10)
    : 1000,
};
app.get("/mipsweb-config.json", (_, res) => {
  res.json(config);
});

app.get("/", (_, res) => {
  res.sendFile(path.join(__dirname, "index.html"));
});

// 404 handler
app.use((_, res) => {
  res.status(404).send("404 - Not Found");
});

app.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`);
  if (config.mode === "evaluator")
    console.log(`Evaluator mode: max ${config.evaluatorMaxSteps} steps per run`);
});
