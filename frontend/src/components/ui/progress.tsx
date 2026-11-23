type ProgressProps = {
  value: number
}

export function Progress({ value }: ProgressProps) {
  return (
    <div
      className="progress"
      aria-valuemax={100}
      aria-valuemin={0}
      aria-valuenow={value}
      role="progressbar"
    >
      <div className="progress__value" style={{ width: `${Math.max(0, Math.min(100, value))}%` }} />
    </div>
  )
}
