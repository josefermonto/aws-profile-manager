/**
 * AWS regions, for the region pickers. Any code can still be typed, so a
 * region launched after this list was written works too.
 */
export const AWS_REGIONS: ReadonlyArray<{ code: string; name: string }> = [
  { code: 'us-east-1', name: 'US East (N. Virginia)' },
  { code: 'us-east-2', name: 'US East (Ohio)' },
  { code: 'us-west-1', name: 'US West (N. California)' },
  { code: 'us-west-2', name: 'US West (Oregon)' },
  { code: 'ca-central-1', name: 'Canada (Central)' },
  { code: 'ca-west-1', name: 'Canada West (Calgary)' },
  { code: 'mx-central-1', name: 'Mexico (Central)' },
  { code: 'sa-east-1', name: 'South America (São Paulo)' },
  { code: 'eu-central-1', name: 'Europe (Frankfurt)' },
  { code: 'eu-central-2', name: 'Europe (Zurich)' },
  { code: 'eu-west-1', name: 'Europe (Ireland)' },
  { code: 'eu-west-2', name: 'Europe (London)' },
  { code: 'eu-west-3', name: 'Europe (Paris)' },
  { code: 'eu-south-1', name: 'Europe (Milan)' },
  { code: 'eu-south-2', name: 'Europe (Spain)' },
  { code: 'eu-north-1', name: 'Europe (Stockholm)' },
  { code: 'il-central-1', name: 'Israel (Tel Aviv)' },
  { code: 'me-south-1', name: 'Middle East (Bahrain)' },
  { code: 'me-central-1', name: 'Middle East (UAE)' },
  { code: 'af-south-1', name: 'Africa (Cape Town)' },
  { code: 'ap-east-1', name: 'Asia Pacific (Hong Kong)' },
  { code: 'ap-east-2', name: 'Asia Pacific (Taipei)' },
  { code: 'ap-south-1', name: 'Asia Pacific (Mumbai)' },
  { code: 'ap-south-2', name: 'Asia Pacific (Hyderabad)' },
  { code: 'ap-northeast-1', name: 'Asia Pacific (Tokyo)' },
  { code: 'ap-northeast-2', name: 'Asia Pacific (Seoul)' },
  { code: 'ap-northeast-3', name: 'Asia Pacific (Osaka)' },
  { code: 'ap-southeast-1', name: 'Asia Pacific (Singapore)' },
  { code: 'ap-southeast-2', name: 'Asia Pacific (Sydney)' },
  { code: 'ap-southeast-3', name: 'Asia Pacific (Jakarta)' },
  { code: 'ap-southeast-4', name: 'Asia Pacific (Melbourne)' },
  { code: 'ap-southeast-5', name: 'Asia Pacific (Malaysia)' },
  { code: 'ap-southeast-7', name: 'Asia Pacific (Thailand)' },
  { code: 'us-gov-east-1', name: 'AWS GovCloud (US-East)' },
  { code: 'us-gov-west-1', name: 'AWS GovCloud (US-West)' },
];

export function regionName(code: string): string | null {
  return AWS_REGIONS.find(r => r.code === code.trim())?.name ?? null;
}
