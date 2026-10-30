import { createFileRoute, ClientOnly } from "@tanstack/react-router";
import { lazy, Suspense } from "react";

const CadEditor = lazy(() => import("@/components/cad/CadEditor"));

export const Route = createFileRoute("/")({
  head: () => ({
    meta: [
      { title: "Pulizia DWG — Visualizzatore ed editor CAD online" },
      { name: "description", content: "Apri file DWG e DXF, cancella testi e linee, disegna geometrie ed esporta in DXF." },
      { property: "og:title", content: "Pulizia DWG — Editor CAD minimale" },
      { property: "og:description", content: "Visualizza e modifica file DWG/DXF nel browser con zoom, pan e strumenti essenziali." },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary_large_image" },
    ],
  }),
  component: Index,
});

function Index() {
  const fallback = <div className="grid h-screen place-items-center bg-background font-mono text-sm text-muted-foreground">Caricamento editor…</div>;
  return (
    <ClientOnly fallback={fallback}>
      <Suspense fallback={fallback}>
        <CadEditor />
      </Suspense>
    </ClientOnly>
  );
}
