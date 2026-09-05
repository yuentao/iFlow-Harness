import { createRoot } from "react-dom/client";
import { App } from "./App";
import { setupHostListener } from "./store";
import "./styles.css";

setupHostListener();
createRoot(document.getElementById("root")!).render(<App />);
