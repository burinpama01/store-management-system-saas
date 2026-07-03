"use client";

import { type CSSProperties, useState } from "react";
import { GlassPanel } from "./MarketingShell";
import { MarketingHeroScene } from "./MarketingHeroScene";

export type LandingWorkflowStep = {
  title: string;
  detail: string;
  bullets: string[];
  image: {
    desktop: string;
    mobile: string;
  };
};

type LandingWorkflowProps = {
  steps: LandingWorkflowStep[];
};

export function LandingWorkflow({ steps }: LandingWorkflowProps) {
  const [activeIndex, setActiveIndex] = useState(0);
  const activeStep = steps[activeIndex] ?? steps[0];
  const progress = steps.length > 1 ? `${(activeIndex / (steps.length - 1)) * 100}%` : "0%";

  return (
    <>
      <div
        className="reference-step-line"
        aria-label="workflow StoreOS"
        style={{ "--workflow-progress": progress } as CSSProperties}
      >
        {steps.map((step, index) => (
          <button
            key={step.title}
            type="button"
            className={index === activeIndex ? "is-active" : ""}
            aria-pressed={index === activeIndex}
            onClick={() => setActiveIndex(index)}
          >
            <span>{index + 1}</span>
            <strong>{step.title}</strong>
          </button>
        ))}
      </div>

      <GlassPanel className="reference-feature-panel" aria-live="polite" data-step={activeIndex + 1}>
        <div key={activeStep.title} className="reference-feature-copy">
          <span className="reference-number">{activeIndex + 1}</span>
          <h3>{activeStep.title}</h3>
          <p>{activeStep.detail}</p>
          <ul>
            {activeStep.bullets.map((item) => (
              <li key={item}>{item}</li>
            ))}
          </ul>
        </div>
        <div className="reference-feature-visual" aria-hidden="true">
          <MarketingHeroScene className="reference-feature-scene" />
          <picture key={`${activeStep.title}-image`} className="reference-feature-picture">
            <source media="(max-width: 767px)" srcSet={activeStep.image.mobile} />
            <img
              className="reference-feature-image"
              src={activeStep.image.desktop}
              width={1280}
              height={720}
              alt=""
              loading="eager"
              decoding="async"
              draggable={false}
            />
          </picture>
        </div>
      </GlassPanel>

      <div className="reference-mini-grid">
        {steps.slice(1).map((step, index) => {
          const stepIndex = index + 1;

          return (
            <button
              key={step.title}
              type="button"
              className={`marketing-glass reference-mini-card${stepIndex === activeIndex ? " is-active" : ""}`}
              aria-pressed={stepIndex === activeIndex}
              onClick={() => setActiveIndex(stepIndex)}
            >
              <span>{stepIndex + 1}</span>
              <strong>{step.title}</strong>
              <p>{step.detail}</p>
            </button>
          );
        })}
      </div>
    </>
  );
}
