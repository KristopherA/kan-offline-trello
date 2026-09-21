import { twMerge } from "tailwind-merge";

interface CircularProgressProps {
  progress: number; // 0-100
  size?: "sm" | "md" | "lg";
  className?: string;
}

const CircularProgress = ({
  progress,
  size = "md",
  className,
}: CircularProgressProps) => {
  const radius = 40;
  const circumference = 2 * Math.PI * radius;
  const strokeDashoffset = circumference - (progress / 100) * circumference;

  return (
    <div className={twMerge("relative", className)}>
      <svg
        className={twMerge(
          "-rotate-90 transform",
          size === "sm" && "h-4 w-4",
          size === "md" && "h-5 w-5",
          size === "lg" && "h-8 w-8",
        )}
        viewBox="0 0 100 100"
      >
        <circle
          cx="50"
          cy="50"
          r={radius}
          fill="none"
          stroke="currentColor"
          strokeWidth="14"
          className="text-light-300 dark:text-dark-400"
        />
        <circle
          cx="50"
          cy="50"
          r={radius}
          fill="none"
          stroke="currentColor"
          strokeWidth="14"
          strokeDasharray={circumference}
          strokeDashoffset={strokeDashoffset}
          strokeLinecap="round"
          className={twMerge(
            "transition-all duration-300 ease-in-out",
            progress === 100 ? "text-green-500" : "text-blue-500",
          )}
        />
      </svg>
    </div>
  );
};

export default CircularProgress;
