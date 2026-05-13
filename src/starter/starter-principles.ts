/**
 * Starter principles — ported verbatim from sage-council/src/types/principles.ts.
 *
 * Eight Ray Dalio-inspired principles seeded into a fresh workspace.
 */
import { Principle } from '../storage/types.js';

export const STARTER_PRINCIPLES: Omit<Principle, 'id' | 'createdAt' | 'updatedAt'>[] = [
  {
    category: 'life',
    title: 'Embrace Reality and Deal With It',
    description:
      'Accept how things really are, not how you wish them to be. Reality is the ultimate arbiter of truth.',
    behavior:
      'When facing a difficult situation, ask "What is the reality here?" before reacting. Face uncomfortable truths head-on.',
    antiPattern:
      'Denial, wishful thinking, avoiding uncomfortable conversations, rationalizing poor outcomes.',
    triggerQuestions: [
      'Am I seeing reality or what I want to see?',
      'What uncomfortable truth am I avoiding?',
    ],
    priority: 9,
    examples: [
      "Acknowledging a business strategy isn't working despite emotional investment",
      'Accepting feedback that challenges self-image',
    ],
    isActive: true,
  },
  {
    category: 'meta',
    title: 'Pain + Reflection = Progress',
    description:
      'Painful experiences are opportunities for learning. The key is to reflect on them rather than avoid them.',
    behavior:
      'When experiencing emotional pain from failure or criticism, pause and extract the lesson before moving on.',
    antiPattern: 'Avoiding situations that might cause pain, blaming others, repeating the same mistakes.',
    triggerQuestions: ['What is this pain trying to teach me?', 'What pattern am I repeating?'],
    priority: 8,
    examples: [
      'Analyzing why a project failed to improve future approaches',
      'Using rejection to refine your pitch',
    ],
    isActive: true,
  },
  {
    category: 'work',
    title: 'Disagree and Commit',
    description:
      'Voice your dissent openly, but once a decision is made, fully commit to it regardless of your initial position.',
    behavior:
      'In discussions, share your honest perspective. After a decision, give it your full support and effort.',
    antiPattern: 'Silent disagreement, passive-aggressive compliance, undermining decisions you disagreed with.',
    triggerQuestions: [
      'Have I voiced my concerns?',
      'Am I giving this my full commitment despite disagreeing?',
    ],
    priority: 8,
    examples: [
      'Supporting a team direction after debate concludes',
      'Executing a strategy you argued against with full effort',
    ],
    isActive: true,
  },
  {
    category: 'life',
    title: 'Be Radically Open-Minded',
    description:
      'Actively seek out perspectives that challenge your beliefs. The goal is to find the best answer, not to be right.',
    behavior:
      'When someone disagrees with you, get curious instead of defensive. Ask questions to understand their reasoning.',
    antiPattern:
      'Defending positions ego-driven, dismissing opposing views, surrounding yourself with yes-people.',
    triggerQuestions: [
      'Am I defending my ego or seeking truth?',
      'What am I missing that others might see?',
    ],
    priority: 9,
    examples: [
      'Changing your mind when presented with better evidence',
      'Seeking advice from people who think differently',
    ],
    isActive: true,
  },
  {
    category: 'work',
    title: 'Think for Yourself',
    description:
      'Develop your own principles and conclusions rather than blindly following others or conventional wisdom.',
    behavior:
      'Before adopting an idea, stress-test it against your own experience and reasoning. Question assumptions.',
    antiPattern:
      'Following the crowd, deferring to authority without critical thinking, adopting trendy ideas uncritically.',
    triggerQuestions: ['Why do I believe this?', 'Have I tested this idea against my own experience?'],
    priority: 7,
    examples: [
      'Questioning industry "best practices"',
      'Developing your own framework instead of copying others',
    ],
    isActive: true,
  },
  {
    category: 'relationships',
    title: 'Be Direct and Honest',
    description:
      'Say what you really think, with kindness but without sugarcoating. Authentic relationships require honest communication.',
    behavior:
      "Share your genuine perspective even when it's uncomfortable. Deliver hard truths with compassion but without evasion.",
    antiPattern:
      'Telling people what they want to hear, avoiding difficult conversations, being vague to avoid conflict.',
    triggerQuestions: ['Am I being fully honest?', 'What am I holding back that needs to be said?'],
    priority: 8,
    examples: [
      'Giving honest feedback to a struggling colleague',
      'Addressing relationship issues directly',
    ],
    isActive: true,
  },
  {
    category: 'meta',
    title: 'Own Your Mistakes',
    description: 'Take full responsibility for your failures and mistakes. They are your greatest teachers.',
    behavior:
      'When something goes wrong, immediately acknowledge your role. Focus on what you can learn and improve.',
    antiPattern: 'Blaming circumstances or others, hiding mistakes, making excuses, defending poor decisions.',
    triggerQuestions: ['What was my contribution to this problem?', 'What would I do differently?'],
    priority: 8,
    examples: [
      'Acknowledging a hiring mistake instead of blaming the candidate',
      'Admitting a strategic error to stakeholders',
    ],
    isActive: true,
  },
  {
    category: 'work',
    title: 'Believability-Weight Decisions',
    description:
      "Not all opinions are equal. Weight input based on people's track record and expertise in the relevant domain.",
    behavior:
      'Consider who has the most relevant experience and success when evaluating advice. Seek input from the most credible sources.',
    antiPattern: 'Giving equal weight to all opinions, ignoring expertise, deferring to loudest voices.',
    triggerQuestions: [
      'Who has the best track record on this topic?',
      'Whose judgment should I weight most heavily?',
    ],
    priority: 7,
    examples: [
      'Seeking technical advice from engineers, not just managers',
      'Valuing market feedback over internal opinions',
    ],
    isActive: true,
  },
];
