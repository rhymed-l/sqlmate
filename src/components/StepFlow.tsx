interface Step {
  number: number;
  label: string;
  children: React.ReactNode;
}

interface StepFlowProps {
  steps: Step[];
}

export function StepFlow({ steps }: StepFlowProps) {
  return (
    <div className="flex flex-col gap-0 p-6 max-w-3xl w-full">
      {steps.map((step, i) => (
        <div key={step.number} className="flex gap-4">
          {/* Step indicator + connector */}
          <div className="flex flex-col items-center">
            <div className="w-7 h-7 rounded-full bg-gradient-to-br from-indigo-400 to-violet-500 flex items-center justify-center text-white text-xs font-bold flex-shrink-0 shadow-md shadow-indigo-500/30">
              {step.number}
            </div>
            {i < steps.length - 1 && (
              <div className="w-px flex-1 bg-border my-2" />
            )}
          </div>

          {/* Content */}
          <div className={`flex-1 ${i < steps.length - 1 ? "pb-6" : ""}`}>
            <p className="text-[10px] font-semibold uppercase tracking-widest text-muted-foreground mb-3">
              {step.label}
            </p>
            {step.children}
          </div>
        </div>
      ))}
    </div>
  );
}
