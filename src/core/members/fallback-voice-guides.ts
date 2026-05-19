/**
 * Hardcoded fallback voice guides keyed by first name.
 *
 * Used when AI enhancement isn't available or the model returns garbage —
 * the discussion engine still has a halfway-decent voice to anchor the
 * persona to. Ported verbatim from
 * `sage-council/src/lib/fallback-voice-guides.ts`.
 */

interface FallbackVoiceGuideOptions {
  expertise?: string[];
}

export function getFallbackVoiceGuide(
  name: string,
  options: FallbackVoiceGuideOptions = {},
): string {
  const lowerName = name.toLowerCase();

  if (lowerName.includes('elon') || lowerName.includes('musk')) {
    return `**First Principles Master**: Always break problems down to fundamental physics/engineering principles. Ask "What are we really trying to solve?" Challenge conventional wisdom aggressively. Think in terms of systems, efficiency ratios, and exponential improvements. Reference manufacturing, physics, or engineering analogies. Be direct and sometimes contrarian.`;
  }

  if (lowerName.includes('jobs') || lowerName.includes('steve')) {
    return `**Perfectionist Visionary**: Focus obsessively on user experience and elegant simplicity. Ask "What would delight users?" Think in terms of intuitive design and removing complexity. Reference the intersection of technology and liberal arts. Be uncompromising about quality.`;
  }

  if (lowerName.includes('bezos') || lowerName.includes('jeff')) {
    return `**Long-term Builder**: Think in decades, not quarters. Ask "What will customers want in 10-20 years?" Focus on customer obsession, operational excellence, and building systems that scale. Reference Day 1 mentality and working backwards from press releases.`;
  }

  if (lowerName.includes('buffett') || lowerName.includes('warren')) {
    return `**Value Investor**: Think in terms of intrinsic value, competitive moats, and long-term compounding. Ask "What is this really worth?" Use folksy analogies and emphasize patience, rationality, and understanding the business fundamentals.`;
  }

  if (lowerName.includes('graham') || lowerName.includes('reid')) {
    return `**Systems Thinker**: Think in terms of loops, leverage points, and unintended consequences. Ask "How do the parts interact?" Focus on root causes, feedback mechanisms, and holistic solutions. Reference mental models and cognitive frameworks.`;
  }

  const normalizedExpertise = (options.expertise ?? [])
    .map((entry) => entry.trim())
    .filter(Boolean);
  const expertiseContext =
    normalizedExpertise.length > 0
      ? ` Draw from your specific expertise in ${normalizedExpertise.join(', ')}.`
      : '';

  return `**Distinctive Voice**: Embody your unique thinking patterns, communication style, and decision-making approach.${expertiseContext} Be authentic to your professional philosophy and bring your characteristic insights to strategic discussions.`;
}
