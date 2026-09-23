"use client";

import { useEffect } from "react";
import { usePathname, useRouter } from "next/navigation";

export default function DesktopNavigationBridge() {
  const pathname = usePathname();
  const router = useRouter();

  useEffect(() => {
    window.postureDesktop?.monitoring.syncRoute(pathname);
  }, [pathname]);

  useEffect(() => {
    const monitoring = window.postureDesktop?.monitoring;
    if (!monitoring) return;

    const handleClick = (event: MouseEvent) => {
      if (
        event.defaultPrevented ||
        event.button !== 0 ||
        event.metaKey ||
        event.ctrlKey ||
        event.shiftKey ||
        event.altKey
      ) {
        return;
      }

      const target = event.target;
      if (!(target instanceof Element)) return;

      const anchor = target.closest("a[href]");
      if (!(anchor instanceof HTMLAnchorElement) || anchor.download) return;
      if (anchor.target && anchor.target !== "_self") return;

      const url = new URL(anchor.href, window.location.href);
      if (url.origin !== window.location.origin) return;
      if (
        url.pathname === window.location.pathname &&
        url.search === window.location.search &&
        url.hash
      ) {
        return;
      }

      const route = `${url.pathname}${url.search}${url.hash}`;
      event.preventDefault();

      void monitoring
        .navigate(route)
        .then((handled) => {
          if (!handled) router.push(route);
        })
        .catch(() => router.push(route));
    };

    document.addEventListener("click", handleClick, true);
    return () => document.removeEventListener("click", handleClick, true);
  }, [router]);

  return null;
}
