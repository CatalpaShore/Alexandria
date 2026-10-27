import React from "react";
import ReactDOM from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import "antd/dist/reset.css";
import { App } from "./App";
import { AccessGate } from "./components/AccessGate";
import { I18nProvider } from "./i18n";
import "./motion.css";
import "./styles.css";
import "./icon-alignment.css";
import "./onboarding.css";

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 60_000,
      gcTime: 30 * 60 * 1000,
      refetchOnWindowFocus: false,
      refetchOnReconnect: false,
      retry: 1
    }
  }
});

function renderApp(): void {
  ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
    <React.StrictMode>
      <QueryClientProvider client={queryClient}>
        <I18nProvider><AccessGate><App /></AccessGate></I18nProvider>
      </QueryClientProvider>
    </React.StrictMode>
  );
}

renderApp();
