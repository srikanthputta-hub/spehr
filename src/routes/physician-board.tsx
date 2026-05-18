import { createFileRoute } from "@tanstack/react-router";
import { PlaceholderBoard } from "@/components/BoardShell";

export const Route = createFileRoute("/physician-board")({
  component: () => (
    <PlaceholderBoard
      title="Attending Physician Board"
      badge="Provider"
      description="Patient panel, pending orders, and clinical review queue will appear here."
    />
  ),
});