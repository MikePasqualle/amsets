"use client";

import { useRef, useState } from "react";
import { useDragZone } from "@/components/animations/useDragZone";

interface DragZoneProps {
  onFile: (file: File) => void;
  accept?: string;
  maxSizeMB?: number;
  /** Override the default video-only MIME type list (e.g. for preview image pickers) */
  allowedMimeTypes?: string[];
  label?: string;
  subLabel?: string;
}

// Only video uploads are supported — content is delivered via Livepeer Studio.
const ALLOWED_TYPES = [
  "video/mp4",
  "video/quicktime",
  "video/webm",
  "video/x-msvideo",
  "video/avi",
  "video/mov",
  "video/x-matroska",
];

/**
 * Drag-and-drop file upload zone with GSAP state animations.
 * States: idle (dashed border) | dragover (yellow glow) | success (green border)
 */
export function DragZone({ onFile, maxSizeMB = 10240, allowedMimeTypes, label, subLabel }: DragZoneProps) {
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const effectiveTypes = allowedMimeTypes ?? ALLOWED_TYPES;

  const handleFile = (file: File) => {
    setError(null);

    const isAllowed = effectiveTypes.some((t) =>
      t.endsWith("/*") ? file.type.startsWith(t.replace("/*", "/")) : file.type === t
    );
    if (!isAllowed) {
      setError(`File type "${file.type}" is not supported.`);
      return;
    }

    if (file.size > maxSizeMB * 1024 * 1024) {
      setError(`File exceeds the ${maxSizeMB}MB limit.`);
      return;
    }

    setSelectedFile(file);
    onFile(file);
  };

  const { ref, dragState } = useDragZone(handleFile);

  const formatSize = (bytes: number) => {
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  };

  return (
    <div
      ref={ref as React.RefObject<HTMLDivElement>}
      onClick={() => inputRef.current?.click()}
      className="relative w-full rounded-xl border-2 border-dashed border-[#3D2F5A] p-10 cursor-pointer flex flex-col items-center justify-center gap-4 min-h-[200px] transition-colors"
      style={{ willChange: "transform, border-color, background-color" }}
    >
      <input
        ref={inputRef}
        type="file"
        className="hidden"
        accept={effectiveTypes.join(",")}
        onChange={(e) => {
          const file = e.target.files?.[0];
          if (file) handleFile(file);
        }}
      />

      {/* Icon */}
      {dragState === "success" ? (
        <SuccessIcon />
      ) : (
        <UploadIcon isDragOver={dragState === "dragover"} />
      )}

      {/* Text */}
      {selectedFile ? (
        <div className="text-center">
          <p className="text-[#81D0B5] font-medium">{selectedFile.name}</p>
          <p className="text-[#7A6E8E] text-sm">{formatSize(selectedFile.size)}</p>
        </div>
      ) : (
        <div className="text-center">
          <p className="text-[#EDE8F5] font-medium">
            {dragState === "dragover"
              ? `Drop ${label ?? "video"} to upload`
              : `Drop your ${label ?? "video"} here`}
          </p>
          <p className="text-[#7A6E8E] text-sm mt-1">
            or click to browse • max {maxSizeMB >= 1024 ? `${(maxSizeMB / 1024).toFixed(0)} GB` : `${maxSizeMB} MB`}
          </p>
          <p className="text-[#3D2F5A] text-xs mt-2">
            {subLabel ?? "MP4 · MOV · WebM · AVI · MKV"}
          </p>
        </div>
      )}

      {error && (
        <p className="text-red-400 text-sm text-center">{error}</p>
      )}
    </div>
  );
}

function UploadIcon({ isDragOver }: { isDragOver: boolean }) {
  return (
    <svg
      width="48"
      height="48"
      viewBox="0 0 48 48"
      fill="none"
      className={`transition-colors duration-200 ${isDragOver ? "text-[#F7FF88]" : "text-[#3D2F5A]"}`}
    >
      <path
        d="M24 32V16M24 16l-6 6M24 16l6 6"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path
        d="M8 36a8 8 0 01-1.5-15.8A12 12 0 0124 8a12 12 0 0117.5 12.2A8 8 0 0140 36"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
      />
    </svg>
  );
}

function SuccessIcon() {
  return (
    <svg
      width="48"
      height="48"
      viewBox="0 0 48 48"
      fill="none"
      className="text-[#81D0B5]"
    >
      <circle cx="24" cy="24" r="20" stroke="currentColor" strokeWidth="2" />
      <path
        d="M15 24l7 7 11-11"
        stroke="currentColor"
        strokeWidth="2.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}
