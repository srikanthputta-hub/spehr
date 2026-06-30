import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  Outlet,
  Link,
  createRootRouteWithContext,
  useRouter,
  HeadContent,
  Scripts,
} from "@tanstack/react-router";

import appCss from "../styles.css?url";
import { FacilityProvider } from "@/lib/facility-context";
import { useAIAutomation } from "@/hooks/useAIAutomation";
import { useAutomationWatchdog } from "@/hooks/useAutomationWatchdog";
import { useBackgroundFhirSync } from "@/hooks/useBackgroundFhirSync";
import { useStartupRecovery } from "@/hooks/useStartupRecovery";
import { useAutoTerminologist } from "@/hooks/useAutoTerminologist";
import { startLocalGcSweeper } from "@/lib/local-gc";
import { useEffect } from "react";

function NotFoundComponent() {
  return (
    <div className="flex min-h-screen items-center justify-center bg-background px-4">
      <div className="max-w-md text-center">
        <h1 className="text-7xl font-bold text-foreground">404</h1>
        <h2 className="mt-4 text-xl font-semibold text-foreground">Page not found</h2>
        <p className="mt-2 text-sm text-muted-foreground">
          The page you're looking for doesn't exist or has been moved.
        </p>
        <div className="mt-6">
          <Link
            to="/"
            className="inline-flex items-center justify-center rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90"
          >
            Go home
          </Link>
        </div>
      </div>
    </div>
  );
}

function ErrorComponent({ error, reset }: { error: Error; reset: () => void }) {
  console.error(error);
  const router = useRouter();

  return (
    <div className="flex min-h-screen items-center justify-center bg-background px-4">
      <div className="max-w-md text-center">
        <h1 className="text-xl font-semibold tracking-tight text-foreground">
          This page didn't load
        </h1>
        <p className="mt-2 text-sm text-muted-foreground">
          Something went wrong on our end. You can try refreshing or head back home.
        </p>
        <div className="mt-6 flex flex-wrap justify-center gap-2">
          <button
            onClick={() => {
              router.invalidate();
              reset();
            }}
            className="inline-flex items-center justify-center rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90"
          >
            Try again
          </button>
          <a
            href="/"
            className="inline-flex items-center justify-center rounded-md border border-input bg-background px-4 py-2 text-sm font-medium text-foreground transition-colors hover:bg-accent"
          >
            Go home
          </a>
        </div>
      </div>
    </div>
  );
}

export const Route = createRootRouteWithContext<{ queryClient: QueryClient }>()({
  head: () => ({
    meta: [
      { charSet: "utf-8" },
      { name: "viewport", content: "width=device-width, initial-scale=1" },
      { title: "S.P.E.H.R" },
      { name: "description", content: "S Group Private Network - Unified multi-role clinical workstation, provider CPOE, live telemetry simulator, and pharmacy verification queue.\"" },
      { name: "author", content: "Lovable" },
      { property: "og:title", content: "S.P.E.H.R" },
      { property: "og:description", content: "S Group Private Network - Unified multi-role clinical workstation, provider CPOE, live telemetry simulator, and pharmacy verification queue.\"" },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
      { name: "twitter:site", content: "@Lovable" },
      { name: "twitter:title", content: "S.P.E.H.R" },
      { name: "twitter:description", content: "S Group Private Network - Unified multi-role clinical workstation, provider CPOE, live telemetry simulator, and pharmacy verification queue.\"" },
      { property: "og:image", content: "https://storage.googleapis.com/gpt-engineer-file-uploads/attachments/og-images/0d2c7edd-d642-42a1-986a-b9ecefb42945" },
      { name: "twitter:image", content: "https://storage.googleapis.com/gpt-engineer-file-uploads/attachments/og-images/0d2c7edd-d642-42a1-986a-b9ecefb42945" },
    ],
    links: [
      {
        rel: "stylesheet",
        href: appCss,
      },
    ],
  }),
  shellComponent: RootShell,
  component: RootComponent,
  notFoundComponent: NotFoundComponent,
  errorComponent: ErrorComponent,
});

function RootShell({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <head>
        <HeadContent />
      </head>
      <body>
        {children}
        <Scripts />
      </body>
    </html>
  );
}

function RootComponent() {
  const { queryClient } = Route.useRouteContext();
  useAIAutomation();
  useAutomationWatchdog();
  useBackgroundFhirSync();
  useStartupRecovery();
  useAutoTerminologist();
  useEffect(() => { startLocalGcSweeper(); }, []);

  return (
    <QueryClientProvider client={queryClient}>
      <FacilityProvider>
        <Outlet />
      </FacilityProvider>
    </QueryClientProvider>
  );
}
