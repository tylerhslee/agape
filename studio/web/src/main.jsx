import React from "react";
import ReactDOM from "react-dom/client";
import "./monacoSetup.js"; // configure the bundled Monaco before any editor mounts
import Root from "./Root.jsx";
import "./theme.css";

ReactDOM.createRoot(document.getElementById("root")).render(
  <React.StrictMode>
    <Root />
  </React.StrictMode>
);
