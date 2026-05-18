import { createFileRoute } from "@tanstack/react-router";
import { PlaceholderBoard } from "@/components/BoardShell";

export const Route = createFileRoute("/unit-manager")({
  component: () => (
    <PlaceholderBoard
      title="Unit Admin Console"
      badge="Operations"
      description="Census, staffing grid, and throughput metrics will appear here."
    />
  ),
});