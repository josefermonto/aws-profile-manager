import awsOnLight from '../assets/aws-icon.webp';
import awsOnDark from '../assets/aws-icon-dark.webp';

const square = (size: number) => ({ width: size, height: size });

/**
 * The AWS logo: dark lettering in the light theme, the navy tile in the dark
 * one (the same pattern as connect-inspector). `tile` always shows the navy
 * tile, for surfaces that are dark in both themes, like the top bar.
 */
export function AwsLogo({ size = 16, tile = false, className = '' }: { size?: number; tile?: boolean; className?: string }) {
  if (tile) {
    return <img src={awsOnDark} alt="" aria-hidden width={size} height={size} style={square(size)} className={`shrink-0 rounded-[22%] ${className}`} />;
  }
  return (
    <>
      <img src={awsOnLight} alt="" aria-hidden width={size} height={size} style={square(size)} className={`shrink-0 object-contain dark:hidden ${className}`} />
      <img src={awsOnDark} alt="" aria-hidden width={size} height={size} style={square(size)} className={`hidden shrink-0 rounded-[22%] dark:block ${className}`} />
    </>
  );
}
