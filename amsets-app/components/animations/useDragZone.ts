"use client";

import { useEffect, useRef, useState } from "react";
import gsap from "gsap";

type DragState = "idle" | "dragover" | "success" | "error";

/**
 * Drag-and-drop animation hook for the file upload zone.
 * Returns ref, drag state, and file handler.
 */
export function useDragZone(onFile: (file: File) => void) {
  const ref = useRef<HTMLDivElement | null>(null);
  const [dragState, setDragState] = useState<DragState>("idle");

  useEffect(() => {
    const el = ref.current;
    if (!el) return;

    // Animate dashed border offset continuously (idle state)
    const idleTween = gsap.to(el, {
      backgroundPositionX: "100%",
      duration: 3,
      repeat: -1,
      ease: "linear",
    });

    const onDragOver = (e: DragEvent) => {
      e.preventDefault();
      if (dragState === "dragover") return;
      setDragState("dragover");

      gsap.to(el, {
        scale: 1.02,
        borderColor: "#F7FF88",
        backgroundColor: "rgba(247, 255, 136, 0.05)",
        duration: 0.2,
        ease: "power2.out",
        overwrite: true,
      });
    };

    const onDragLeave = () => {
      setDragState("idle");
      gsap.to(el, {
        scale: 1,
        borderColor: "#3D2F5A",
        backgroundColor: "transparent",
        duration: 0.25,
        ease: "power2.inOut",
        overwrite: true,
      });
    };

    const onDrop = (e: DragEvent) => {
      e.preventDefault();
      const file = e.dataTransfer?.files[0];
      if (!file) return;

      setDragState("success");
      gsap.to(el, {
        scale: 1,
        borderColor: "#81D0B5",
        backgroundColor: "rgba(129, 208, 181, 0.05)",
        duration: 0.3,
        ease: "power2.out",
        overwrite: true,
      });

      onFile(file);
    };

    el.addEventListener("dragover", onDragOver as EventListener);
    el.addEventListener("dragleave", onDragLeave);
    el.addEventListener("drop", onDrop as EventListener);

    return () => {
      idleTween.kill();
      el.removeEventListener("dragover", onDragOver as EventListener);
      el.removeEventListener("dragleave", onDragLeave);
      el.removeEventListener("drop", onDrop as EventListener);
    };
  }, [onFile, dragState]);

  const reset = () => {
    setDragState("idle");
    const el = ref.current;
    if (el) {
      gsap.to(el, {
        scale: 1,
        borderColor: "#3D2F5A",
        backgroundColor: "transparent",
        duration: 0.3,
      });
    }
  };

  return { ref, dragState, reset };
}
