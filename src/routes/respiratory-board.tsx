import { createFileRoute } from "@tanstack/react-router";
import { PlaceholderBoard } from "@/components/BoardShell";

export const Route = createFileRoute("/respiratory-board")({
  component: () => (
    <PlaceholderBoard
      title="Respiratory Therapy Board"
      badge="Respiratory"
      description="Ventilator rounds, SpO₂ trends, and scheduled treatments will appear here."
    />
  ),
});