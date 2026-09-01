import { lazy, Suspense } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import "./styles.css";

const preview = new URLSearchParams(window.location.search).get("preview");
const previewMode = new URLSearchParams(window.location.search).get("mode");
const cardStyleMode = previewMode === "media" || previewMode === "text" ? previewMode : "all";
const CardStyleLab = lazy(() => import("./components/CardStyleLab").then(({ CardStyleLab: Component }) => ({ default: Component })));

createRoot(document.getElementById("root")!).render(
  preview === "card-styles"
    ? <Suspense fallback={null}><CardStyleLab mode={cardStyleMode} /></Suspense>
    : <App />,
);

if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    void navigator.serviceWorker.register("/sw.js");
  });
}
