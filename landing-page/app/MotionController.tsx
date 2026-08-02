"use client";

import { useEffect } from "react";

export function MotionController() {
  useEffect(() => {
    const root = document.documentElement;
    const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
    root.classList.add("motion-ready");

    if (reduceMotion.matches) {
      root.classList.add("motion-loaded");
      document.querySelectorAll<HTMLElement>("[data-reveal]").forEach((element) => {
        element.classList.add("is-visible");
      });
      return () => {
        root.classList.remove("motion-ready", "motion-loaded");
      };
    }

    const revealObserver = new IntersectionObserver(
      (entries) => {
        entries.forEach((entry) => {
          if (!entry.isIntersecting) return;
          entry.target.classList.add("is-visible");
          revealObserver.unobserve(entry.target);
        });
      },
      { rootMargin: "0px 0px -10%", threshold: 0.12 },
    );

    document.querySelectorAll<HTMLElement>("[data-reveal]").forEach((element) => {
      revealObserver.observe(element);
    });

    let frame = 0;
    const updateScrollMotion = () => {
      frame = 0;
      const progress = Math.min(window.scrollY / 760, 1);
      root.style.setProperty("--hero-shift", `${progress * 32}px`);
      root.style.setProperty("--hero-tilt", `${progress * 1.8}deg`);
      root.style.setProperty("--hero-fade", `${1 - progress * 0.24}`);
    };
    const onScroll = () => {
      if (frame) return;
      frame = window.requestAnimationFrame(updateScrollMotion);
    };

    window.addEventListener("scroll", onScroll, { passive: true });
    updateScrollMotion();
    window.requestAnimationFrame(() => root.classList.add("motion-loaded"));

    return () => {
      revealObserver.disconnect();
      window.removeEventListener("scroll", onScroll);
      if (frame) window.cancelAnimationFrame(frame);
      root.classList.remove("motion-ready", "motion-loaded");
      root.style.removeProperty("--hero-shift");
      root.style.removeProperty("--hero-tilt");
      root.style.removeProperty("--hero-fade");
    };
  }, []);

  return null;
}
