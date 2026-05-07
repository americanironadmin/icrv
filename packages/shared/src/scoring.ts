// packages/shared/src/scoring.ts
// Phase 4 — rule-based lead scoring. Pure function so it's trivial to unit-test.
//
// Weights (sum to 100): engagement 35 + demographics 25 + behavioral 20 + tags 20.

export interface ActivityCounts {
  opens:           number;
  clicks:          number;
  replies:         number;
  website_visits:  number;
  form_submissions: number;
  last_activity_within_7d: boolean;
}

export interface Demographics {
  country?:  string;   // ISO 3166-1 alpha-2
  industry?: string;
}

export interface LeadScore {
  score:        number;   // 0–100
  category:     'hot' | 'warm' | 'cold';
  engagement:   number;
  demographic:  number;
  behavioral:   number;
  tag:          number;
}

export const TIER1_COUNTRIES  = ['SA', 'AE', 'KW'];
export const TIER2_COUNTRIES  = ['EG', 'BH', 'OM', 'QA'];
export const TIER1_INDUSTRIES = ['construction', 'oil_gas'];
export const TIER2_INDUSTRIES = ['heavy_equipment', 'equipment_dealers'];

const TAG_BONUSES: Record<string, number> = {
  investor: 10, buyer: 10, buyers: 10, dealer: 8, vip: 7, partner: 5, partners: 5,
};

export function calculateLeadScore(
  activity:     ActivityCounts,
  demographics: Demographics,
  tags:         string[],
): LeadScore {
  // Engagement (35%)
  const opens   = Math.min(activity.opens   * 5, 15);
  const clicks  = Math.min(activity.clicks  * 8, 20);
  const replies = Math.min(activity.replies * 10, 15);
  const engagement = ((opens + clicks + replies) / 50) * 35;

  // Demographics (25%)
  const countryBoost = TIER1_COUNTRIES.includes(demographics.country ?? '')   ? 15
                     : TIER2_COUNTRIES.includes(demographics.country ?? '')   ? 8 : 0;
  const industryBoost = TIER1_INDUSTRIES.includes(demographics.industry ?? '') ? 10
                      : TIER2_INDUSTRIES.includes(demographics.industry ?? '') ? 6 : 0;
  const demoScore = ((countryBoost + industryBoost) / 25) * 25;

  // Behavioral (20%)
  const visits      = Math.min(activity.website_visits   * 3, 12);
  const submissions = Math.min(activity.form_submissions * 6, 12);
  const recentBoost = activity.last_activity_within_7d ? 5 : 0;
  const behavioral = ((visits + submissions + recentBoost) / 29) * 20;

  // Tags (20%)
  const tagSum = tags.reduce((sum, t) => sum + (TAG_BONUSES[t.toLowerCase()] ?? 0), 0);
  const tag = (Math.min(tagSum, 40) / 40) * 20;

  const total = Math.round(engagement + demoScore + behavioral + tag);
  const category: LeadScore['category'] = total >= 80 ? 'hot' : total >= 50 ? 'warm' : 'cold';
  return {
    score:       total,
    category,
    engagement:  Math.round(engagement * 10) / 10,
    demographic: Math.round(demoScore  * 10) / 10,
    behavioral:  Math.round(behavioral * 10) / 10,
    tag:         Math.round(tag        * 10) / 10,
  };
}
