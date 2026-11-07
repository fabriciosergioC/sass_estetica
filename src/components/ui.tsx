import type {
  ButtonHTMLAttributes,
  InputHTMLAttributes,
  ReactNode,
  SelectHTMLAttributes,
  TextareaHTMLAttributes,
} from "react";

const btnBase =
  "inline-flex items-center justify-center gap-2 rounded-lg font-medium transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-gold-500 disabled:pointer-events-none disabled:opacity-50";

const btnVariants = {
  primary:
    "bg-gold-500 text-on-accent hover:bg-gold-400 active:bg-gold-600 px-4 py-2 text-sm",
  secondary:
    "bg-zinc-800 text-zinc-100 hover:bg-zinc-700 active:bg-zinc-600 px-4 py-2 text-sm",
  ghost:
    "text-zinc-300 hover:bg-zinc-800 hover:text-zinc-100 px-3 py-2 text-sm",
  danger:
    "bg-red-500/10 text-red-400 border border-red-500/30 hover:bg-red-500/20 px-4 py-2 text-sm",
  outline:
    "border border-zinc-700 text-zinc-200 hover:border-gold-500/60 hover:text-gold-300 px-4 py-2 text-sm",
  action:
    "bg-gold-500 text-on-accent hover:bg-gold-400 active:bg-gold-600 px-4 py-2 text-sm font-semibold",
} as const;

export function Button({
  variant = "primary",
  className = "",
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: keyof typeof btnVariants;
}) {
  return <button className={`${btnBase} ${btnVariants[variant]} ${className}`} {...props} />;
}

const fieldBase =
  "w-full rounded-lg border border-zinc-700 bg-zinc-900 px-3 py-2 text-sm text-zinc-100 placeholder:text-zinc-500 focus:border-gold-500 focus:outline-none transition-colors";

export function Input({ className = "", ...props }: InputHTMLAttributes<HTMLInputElement>) {
  return <input className={`${fieldBase} ${className}`} {...props} />;
}

export function Textarea({ className = "", ...props }: TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return <textarea className={`${fieldBase} min-h-20 ${className}`} {...props} />;
}

export function Select({ className = "", ...props }: SelectHTMLAttributes<HTMLSelectElement>) {
  return <select className={`${fieldBase} ${className}`} {...props} />;
}

export function Field({
  label,
  error,
  hint,
  children,
}: {
  label: string;
  error?: string;
  hint?: string;
  children: ReactNode;
}) {
  return (
    <label className="block space-y-1.5">
      <span className="block text-xs font-medium uppercase tracking-wide text-zinc-400">
        {label}
      </span>
      {children}
      {hint && !error && <span className="block text-xs text-zinc-500">{hint}</span>}
      {error && <span className="block text-xs text-red-400">{error}</span>}
    </label>
  );
}

export function Card({
  className = "",
  children,
}: {
  className?: string;
  children: ReactNode;
}) {
  return (
    <div
      className={`rounded-xl border border-zinc-800 bg-zinc-900/60 shadow-lg shadow-black/20 ${className}`}
    >
      {children}
    </div>
  );
}

export function Badge({
  children,
  tone = "neutral",
}: {
  children: ReactNode;
  tone?: "neutral" | "gold" | "green" | "red" | "blue" | "amber";
}) {
  const tones = {
    neutral: "bg-zinc-800 text-zinc-300 border-zinc-700",
    gold: "bg-gold-500/10 text-gold-400 border-gold-500/30",
    green: "bg-emerald-500/10 text-emerald-400 border-emerald-500/30",
    red: "bg-red-500/10 text-red-400 border-red-500/30",
    blue: "bg-sky-500/10 text-sky-400 border-sky-500/30",
    amber: "bg-amber-500/10 text-amber-400 border-amber-500/30",
  };
  return (
    <span
      className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs font-medium ${tones[tone]}`}
    >
      {children}
    </span>
  );
}

export function EmptyState({
  icon,
  title,
  description,
  action,
}: {
  icon?: ReactNode;
  title: string;
  description?: string;
  action?: ReactNode;
}) {
  return (
    <div className="flex flex-col items-center justify-center gap-2 rounded-xl border border-dashed border-zinc-800 px-6 py-14 text-center">
      {icon && <div className="text-3xl opacity-60">{icon}</div>}
      <p className="font-medium text-zinc-200">{title}</p>
      {description && <p className="max-w-sm text-sm text-zinc-500">{description}</p>}
      {action && <div className="mt-3">{action}</div>}
    </div>
  );
}

export function QRCodeDisplay({
  qrCode,
  size = 200,
}: {
  qrCode: string;
  size?: number;
}) {
  // Baileys QR code is a base64 string of the QR image
  // It can be used directly as an image src
  return (
    <div className="flex flex-col items-center gap-3">
      <div className="bg-white p-3 rounded-lg">
        <img
          src={`data:image/png;base64,${qrCode}`}
          alt="WhatsApp QR Code"
          width={size}
          height={size}
          style={{ imageRendering: "pixelated" }}
        />
      </div>
    </div>
  );
}
