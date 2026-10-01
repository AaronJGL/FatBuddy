import React, { useEffect, useRef } from 'react';

const WIDTH = 360;
const HEIGHT = 230;
const CENTER_X = WIDTH / 2;
const BASE_Y = 205;
const RADIUS = 175;
const WHEEL_SECTORS = 6;
const SECTOR_ANGLE = (Math.PI * 2) / WHEEL_SECTORS;
const INITIAL_SPIN_SPEED = 0.008;
const MAX_SPIN_SPEED = 0.022;
const ACCELERATION_DURATION = 300;
const SPIN_UP_DURATION = 500;
const QUICK_STOP_DURATION = 600;
const QUICK_STOP_MIN_STEPS = 3;
const AUTO_STOP_DURATION = 5000;
const AUTO_STOP_EASE_SLOPE = 3.5;
const AUTO_STOP_EXTRA_STEPS = 2;
const AUTO_STOP_LINEAR_WEIGHT = 0.7;
const AUTO_STOP_FAST_BRAKE_WEIGHT = 0.3;
const AUTO_STOP_FAST_BRAKE_POWER = 7;
const SLICE_COLORS = ['#E76F3C', '#D6A63A', '#438F72', '#4285A5', '#C65C61', '#7865AA'];

const modulo = (value: number, divisor: number) => ((value % divisor) + divisor) % divisor;

const wrapText = (text: string, maxWidth: number, context: CanvasRenderingContext2D) => {
  const lines: string[] = [];
  let line = '';

  for (const character of Array.from(text)) {
    const nextLine = line + character;
    if (line && context.measureText(nextLine).width > maxWidth) {
      lines.push(line);
      line = character;
    } else {
      line = nextLine;
    }
  }

  if (line) lines.push(line);
  return lines;
};

export interface Restaurant {
  id: string;
  name: string;
  lat: number;
  lng: number;
  rating?: number;
  userRatingCount?: number;
  address: string;
  type?: string;
  price?: string;
  priceLevel?: string;
  licenseType?: string;
  phone?: string;
  openingHours?: string;
  googleMapsUri?: string;
  dataUpdatedAt?: number;
  isInactive?: boolean;
  source: 'google' | 'fehd' | 'amap';

  googlePlaceId?: string;
  amapPoiId?: string;
  fehdObjectId?: string;
  sources?: Array<'google' | 'fehd' | 'amap'>;
}
interface RouletteProps {
  candidates: Restaurant[];
  autoStart?: boolean;
  onFinish: (selected: Restaurant) => void;
}

export const Roulette: React.FC<RouletteProps> = ({ candidates, autoStart = true, onFinish }) => {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const candidatesRef = useRef(candidates);
  const onFinishRef = useRef(onFinish);

  useEffect(() => {
    candidatesRef.current = candidates;
  }, [candidates]);

  useEffect(() => {
    onFinishRef.current = onFinish;
  }, [onFinish]);

  useEffect(() => {
    const canvas = canvasRef.current;
    const context = canvas?.getContext('2d');
    if (!canvas || !context) return;

    const activeCandidates = candidatesRef.current;
    if (activeCandidates.length === 0) return;

    const pixelRatio = window.devicePixelRatio || 1;
    canvas.width = WIDTH * pixelRatio;
    canvas.height = HEIGHT * pixelRatio;
    context.setTransform(pixelRatio, 0, 0, pixelRatio, 0, 0);

    let position = 0;
    let speed = autoStart ? INITIAL_SPIN_SPEED : 0;
    let targetSpeed = autoStart ? MAX_SPIN_SPEED : 0;
    let accelerationRemaining = autoStart ? ACCELERATION_DURATION : 0;
    let spinElapsed = 0;
    let motion: 'idle' | 'spinning' | 'slowing' | 'stopped' = autoStart ? 'spinning' : 'idle';
    let animationFrame: number | null = null;
    let previousTime: number | null = null;
    let stopStartTime = 0;
    let stopStartPosition = 0;
    let stopTargetPosition = 0;
    let stopStartStep = 0;
    let stopDuration = 0;
    let stopStartSpeed = 0;
    let automaticSlowdown = false;
    let stopSequence: number[] = [];
    let selectedRestaurant: Restaurant | null = null;

    const restaurantAt = (wheelStep: number) => {
      const currentList = candidatesRef.current;
      if (currentList.length === 0) return { name: '' } as Restaurant;

      if (motion === 'slowing' || motion === 'stopped') {
        const sequenceIndex = wheelStep - stopStartStep;
        if (sequenceIndex >= 0 && sequenceIndex < stopSequence.length) {
          const restaurantIndex = stopSequence[sequenceIndex];
          return currentList[restaurantIndex % currentList.length] || currentList[0];
        }
      }
      return currentList[modulo(wheelStep, currentList.length)];
    };

    const draw = () => {
      context.clearRect(0, 0, WIDTH, HEIGHT);
      const wholePosition = Math.floor(position);
      const wheelRotation = (position + 0.5) * SECTOR_ANGLE;
      const pointerSector = modulo(-wholePosition - 1, WHEEL_SECTORS);

      context.save();
      context.beginPath();
      context.rect(0, 0, WIDTH, BASE_Y);
      context.clip();

      for (let sector = 0; sector < WHEEL_SECTORS; sector += 1) {
        const startAngle = wheelRotation + sector * SECTOR_ANGLE - Math.PI / 2;
        const endAngle = startAngle + SECTOR_ANGLE;
        context.beginPath();
        context.moveTo(CENTER_X, BASE_Y);
        context.arc(CENTER_X, BASE_Y, RADIUS, startAngle, endAngle);
        context.closePath();
        context.fillStyle = SLICE_COLORS[sector];
        context.fill();
        context.strokeStyle = '#FFFFFF';
        context.lineWidth = 3;
        context.stroke();

        const labelAngle = startAngle + SECTOR_ANGLE / 2;
        if (Math.sin(labelAngle) >= -0.15) continue;

        const sectorDistance = modulo(sector - pointerSector, WHEEL_SECTORS);
        const signedSectorDistance = sectorDistance > WHEEL_SECTORS / 2
          ? sectorDistance - WHEEL_SECTORS
          : sectorDistance;
        const wheelStep = wholePosition - signedSectorDistance;
        const restaurant = restaurantAt(wheelStep);
        if (!restaurant || !restaurant.name) continue;

        const labelRadius = RADIUS * 0.65;
        const labelX = CENTER_X + Math.cos(labelAngle) * labelRadius;
        const labelY = BASE_Y + Math.sin(labelAngle) * labelRadius;
        const maxTextWidth = labelRadius * 2 * Math.sin(SECTOR_ANGLE / 2) - 12;

        context.save();
        context.fillStyle = '#FFFFFF';
        context.textAlign = 'center';
        context.textBaseline = 'middle';
        context.shadowColor = 'rgba(0, 0, 0, 0.3)';
        context.shadowBlur = 3;
        let fontSize = 22;
        let lines: string[] = [];
        while (fontSize >= 11) {
          context.font = `600 ${fontSize}px sans-serif`;
          lines = wrapText(restaurant.name, maxTextWidth, context);
          if (lines.length * fontSize * 1.2 <= 64) break;
          fontSize -= 1;
        }
        const lineHeight = fontSize * 1.2;
        lines.forEach((line, index) => {
          const lineY = labelY + (index - (lines.length - 1) / 2) * lineHeight;
          context.fillText(line, labelX, lineY, maxTextWidth);
        });
        context.restore();
      }

      context.beginPath();
      context.arc(CENTER_X, BASE_Y, RADIUS - 1, 0, Math.PI * 2);
      context.strokeStyle = '#FFFFFF';
      context.lineWidth = 5;
      context.stroke();
      context.restore();

      context.beginPath();
      context.moveTo(CENTER_X - 11, 3);
      context.lineTo(CENTER_X + 11, 3);
      context.lineTo(CENTER_X, 27);
      context.closePath();
      context.fillStyle = '#D94A3D';
      context.fill();
    };

    const pickIndex = (excludedIndices: number[]) => {
      const currentList = candidatesRef.current;
      const availableIndices = currentList
        .map((_, index) => index)
        .filter((index) => !excludedIndices.includes(index));
      return availableIndices.length > 0
        ? availableIndices[Math.floor(Math.random() * availableIndices.length)]
        : Math.floor(Math.random() * currentList.length);
    };

    const beginSlowdown = (time: number, quick = false) => {
      const currentList = candidatesRef.current;
      if (currentList.length === 0) return;

      const selectedIndex = Math.floor(Math.random() * currentList.length);
      const currentStep = Math.floor(position);
      const fractionalPosition = position - currentStep;
      automaticSlowdown = !quick;
      const targetDistance = quick
        ? Math.max(QUICK_STOP_MIN_STEPS, (speed * QUICK_STOP_DURATION) / 2)
        : (speed * AUTO_STOP_DURATION) / AUTO_STOP_EASE_SLOPE
          + Math.floor(Math.random() * AUTO_STOP_EXTRA_STEPS);
      const targetOffset = Math.max(1, Math.ceil(fractionalPosition + targetDistance));
      stopSequence = [modulo(currentStep, currentList.length)];

      for (let step = 1; step <= targetOffset; step += 1) {
        const previousIndex = stopSequence[stopSequence.length - 1];
        const nextIndex = step === targetOffset
          ? selectedIndex
          : step === 1
            ? modulo(currentStep + 1, currentList.length)
            : pickIndex([selectedIndex, previousIndex]);
        stopSequence.push(nextIndex);
      }

      selectedRestaurant = currentList[selectedIndex];
      stopStartStep = currentStep;
      stopStartPosition = position;
      const usedAfterSelection = new Set([selectedIndex]);

      for (let sector = 0; sector < WHEEL_SECTORS - 1; sector += 1) {
        const nextIndex = pickIndex([...usedAfterSelection]);
        stopSequence.push(nextIndex);
        usedAfterSelection.add(nextIndex);
      }

      stopTargetPosition = currentStep + targetOffset;
      stopStartTime = time;
      stopStartSpeed = speed;
      const initialSlope = automaticSlowdown ? AUTO_STOP_EASE_SLOPE : 2;
      stopDuration = (initialSlope * (stopTargetPosition - stopStartPosition)) / speed;
      motion = 'slowing';
    };

    const animate = (time: number) => {
      if (previousTime === null) previousTime = time;
      const elapsed = Math.min(time - previousTime, 32);
      previousTime = time;

      if (motion === 'spinning') {
        const previousSpeed = speed;
        if (accelerationRemaining > 0) {
          const accelerationTime = Math.min(elapsed, accelerationRemaining);
          speed += (targetSpeed - speed) * (accelerationTime / accelerationRemaining);
          accelerationRemaining -= accelerationTime;
          if (accelerationRemaining === 0) speed = targetSpeed;
        }
        position += ((previousSpeed + speed) / 2) * elapsed;
        spinElapsed += elapsed;
        if (spinElapsed >= SPIN_UP_DURATION) beginSlowdown(time);
      } else if (motion === 'slowing') {
        const progress = Math.min((time - stopStartTime) / stopDuration, 1);
        const remaining = 1 - progress;
        const easedProgress = automaticSlowdown
          ? 1 - AUTO_STOP_LINEAR_WEIGHT * Math.pow(remaining, 2)
            - AUTO_STOP_FAST_BRAKE_WEIGHT * Math.pow(remaining, AUTO_STOP_FAST_BRAKE_POWER)
          : 1 - Math.pow(remaining, 2);
        position = stopStartPosition + (stopTargetPosition - stopStartPosition) * easedProgress;
        const speedRatio = automaticSlowdown
          ? (2 * AUTO_STOP_LINEAR_WEIGHT * remaining
            + AUTO_STOP_FAST_BRAKE_WEIGHT * AUTO_STOP_FAST_BRAKE_POWER
              * Math.pow(remaining, AUTO_STOP_FAST_BRAKE_POWER - 1)) / AUTO_STOP_EASE_SLOPE
          : remaining;
        speed = stopStartSpeed * speedRatio;
        if (progress === 1) {
          position = stopTargetPosition;
          draw();
          motion = 'stopped';
          animationFrame = null;
          if (selectedRestaurant) onFinishRef.current(selectedRestaurant);
          return;
        }
      } else {
        animationFrame = null;
        return;
      }

      draw();
      animationFrame = window.requestAnimationFrame(animate);
    };

    const startAnimation = () => {
      previousTime = null;
      animationFrame = window.requestAnimationFrame(animate);
    };

    const handleInteraction = () => {
      if (motion === 'idle' || motion === 'stopped') {
        motion = 'spinning';
        speed = 0;
        targetSpeed = INITIAL_SPIN_SPEED;
        accelerationRemaining = ACCELERATION_DURATION;
        spinElapsed = 0;
        startAnimation();
        return;
      }

      if (motion === 'spinning') beginSlowdown(performance.now(), true);
    };

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        handleInteraction();
      }
    };

    canvas.addEventListener('click', handleInteraction);
    canvas.addEventListener('keydown', handleKeyDown);
    draw();
    if (autoStart) startAnimation();

    return () => {
      if (animationFrame !== null) window.cancelAnimationFrame(animationFrame);
      canvas.removeEventListener('click', handleInteraction);
      canvas.removeEventListener('keydown', handleKeyDown);
    };
  }, [autoStart]); // 不以 candidates 作為 dependency，避免選單資料更新時誤發重置

  return (
    <div className="relative mx-auto w-full max-w-sm">
      <canvas
        ref={canvasRef}
        width={WIDTH}
        height={HEIGHT}
        className="block h-auto w-full cursor-pointer drop-shadow-lg transition-transform duration-150 ease-in-out hover:scale-[1.02] active:scale-[0.98]"
        style={{ aspectRatio: `${WIDTH} / ${HEIGHT}` }}
        role="button"
        tabIndex={0}
        aria-label="餐廳抽選轉盤"
      />
    </div>
  );
};