import type { DocumentDescriptor } from "@libre-ai/web-platform";
import { NotebookApp } from "../ui/notebook-app";

export function notebookDocument(): DocumentDescriptor {
  return {
    app: <NotebookApp />,
    clientModule: "/assets/app.js",
    description: "Host local de sauvegarde et restauration chiffrées du Notebook Libre AI.",
    lang: "fr",
    manifest: "/manifest.webmanifest",
    stylesheets: ["/assets/styles.css"],
    title: "Libre AI — Notebook",
  };
}
