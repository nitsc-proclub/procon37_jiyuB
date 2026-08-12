import { forwardRef, useEffect, useImperativeHandle, useRef } from "react";

const TURNSTILE_SCRIPT_ID = "cloudflare-turnstile-explicit";
const TURNSTILE_SCRIPT_URL = "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit";

export type TurnstileStatus = "loading" | "verifying" | "verified" | "expired" | "error";

export type TurnstileHandle = {
  reset: () => void;
};

type TurnstileOptions = {
  sitekey: string;
  callback?: (token: string) => void;
  "expired-callback"?: () => void;
  "error-callback"?: (errorCode: string) => void;
  "timeout-callback"?: () => void;
  theme?: "light" | "dark" | "auto";
  size?: "normal" | "compact" | "flexible";
  language?: string;
  action?: string;
};

type TurnstileApi = {
  render: (container: HTMLElement, options: TurnstileOptions) => string;
  reset: (widgetId?: string) => void;
  remove: (widgetId?: string) => void;
};

declare global {
  interface Window {
    turnstile?: TurnstileApi;
  }
}

let turnstileScriptPromise: Promise<TurnstileApi> | null = null;

const loadTurnstileScript = () => {
  if (window.turnstile) {
    return Promise.resolve(window.turnstile);
  }

  if (turnstileScriptPromise) {
    return turnstileScriptPromise;
  }

  turnstileScriptPromise = new Promise<TurnstileApi>((resolve, reject) => {
    const existingScript = document.getElementById(TURNSTILE_SCRIPT_ID) as HTMLScriptElement | null;
    const script = existingScript ?? document.createElement("script");

    const handleLoad = () => {
      if (window.turnstile) {
        resolve(window.turnstile);
      } else {
        reject(new Error("Turnstile script loaded without its API."));
      }
    };
    const handleError = () => {
      script.remove();
      reject(new Error("Turnstile script could not be loaded."));
    };

    script.addEventListener("load", handleLoad, { once: true });
    script.addEventListener("error", handleError, { once: true });

    if (!existingScript) {
      script.id = TURNSTILE_SCRIPT_ID;
      script.src = TURNSTILE_SCRIPT_URL;
      script.async = true;
      script.defer = true;
      document.head.appendChild(script);
    }
  }).catch((error: unknown) => {
    turnstileScriptPromise = null;
    throw error;
  });

  return turnstileScriptPromise;
};

type TurnstileProps = {
  siteKey: string;
  action: string;
  onToken: (token: string | null) => void;
  onStatusChange: (status: TurnstileStatus) => void;
};

const Turnstile = forwardRef<TurnstileHandle, TurnstileProps>(({ siteKey, action, onToken, onStatusChange }, ref) => {
  const containerRef = useRef<HTMLDivElement>(null);
  const widgetIdRef = useRef<string | null>(null);

  useImperativeHandle(ref, () => ({
    reset: () => {
      const widgetId = widgetIdRef.current;
      if (!widgetId || !window.turnstile) return;
      onToken(null);
      onStatusChange("verifying");
      window.turnstile.reset(widgetId);
    },
  }), [onStatusChange, onToken]);

  useEffect(() => {
    let isCurrent = true;
    const container = containerRef.current;
    if (!container) return;

    onToken(null);
    onStatusChange("loading");

    void loadTurnstileScript()
      .then((turnstile) => {
        if (!isCurrent || !containerRef.current) return;

        onStatusChange("verifying");
        widgetIdRef.current = turnstile.render(containerRef.current, {
          sitekey: siteKey,
          action,
          theme: "light",
          size: "compact",
          language: "ja",
          callback: (token) => {
            if (!isCurrent) return;
            onToken(token);
            onStatusChange("verified");
          },
          "expired-callback": () => {
            if (!isCurrent) return;
            onToken(null);
            onStatusChange("expired");
          },
          "timeout-callback": () => {
            if (!isCurrent) return;
            onToken(null);
            onStatusChange("expired");
          },
          "error-callback": () => {
            if (!isCurrent) return;
            onToken(null);
            onStatusChange("error");
          },
        });
      })
      .catch(() => {
        if (!isCurrent) return;
        onToken(null);
        onStatusChange("error");
      });

    return () => {
      isCurrent = false;
      const widgetId = widgetIdRef.current;
      widgetIdRef.current = null;
      if (widgetId && window.turnstile) {
        window.turnstile.remove(widgetId);
      }
    };
  }, [action, onStatusChange, onToken, siteKey]);

  return <div ref={containerRef} className="flex min-h-[65px] justify-center" aria-label="安全確認" />;
});

Turnstile.displayName = "Turnstile";

export default Turnstile;
