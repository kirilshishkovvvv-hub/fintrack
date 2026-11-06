'use client';

import { useEffect, useRef, useState } from 'react';

/**
 * Small charts with no library (Annex L item 8). Drawn at the real pixel width, so text stays
 * legible on a phone. Every chart sits beside a table with the same values (Annex L item 13),
 * so the tooltip only ever adds convenience. Identity is a legend, never colour alone.
 */
export interface ChartSeries {
  name: string;
  /** A token from globals.css: --series-1 or --series-2. */
  color: string;
  values: number[];
}

interface ChartProps {
  label: string;
  /** One per position on the horizontal axis. */
  labels: string[];
  series: ChartSeries[];
  money: (minor: number) => string;
  /** The tick label on the vertical axis. */
  tick: (minor: number) => string;
}

const HEIGHT = 200;
const MARGIN = { top: 12, right: 12, bottom: 24, left: 52 };
const BAR_MAX = 24;

function useWidth() {
  const ref = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  useEffect(() => {
    const element = ref.current;
    if (!element) return;
    const observer = new ResizeObserver(([entry]) => setWidth(Math.floor(entry!.contentRect.width)));
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  return { ref, width };
}

/** Clean ticks that include zero: 0 / 1,000 / 2,000 and not 0 / 873 / 1,746. */
function scaleFor(values: number[]) {
  const low = Math.min(0, ...values);
  const high = Math.max(0, ...values);
  const span = high - low || 100;
  const rough = span / 4;
  const power = 10 ** Math.floor(Math.log10(rough));
  const step = [1, 2, 5, 10].map((m) => m * power).find((candidate) => candidate >= rough)!;
  const min = Math.floor(low / step) * step;
  const max = Math.ceil(high / step) * step;
  const ticks: number[] = [];
  for (let tick = min; tick <= max; tick += step) ticks.push(tick);
  return { min, max: max === min ? min + step : max, ticks };
}

function Legend({ series }: { series: ChartSeries[] }) {
  if (series.length < 2) return null;
  return (
    <div className="chart-legend small">
      {series.map((item) => (
        <span key={item.name}>
          <span className="chart-key" style={{ background: `var(${item.color})` }} aria-hidden="true" />
          {item.name}
        </span>
      ))}
    </div>
  );
}

function Tooltip({ x, width, title, rows }: { x: number; width: number; title: string; rows: { name: string; color: string; value: string }[] }) {
  const flip = x > width / 2;
  return (
    <div className="chart-tooltip small" style={flip ? { right: width - x + 8 } : { left: x + 8 }}>
      <div className="muted">{title}</div>
      {rows.map((row) => (
        <div className="chart-tooltip-row" key={row.name}>
          <span className="chart-line-key" style={{ background: `var(${row.color})` }} aria-hidden="true" />
          <strong className="amount">{row.value}</strong>
          <span className="muted">{row.name}</span>
        </div>
      ))}
    </div>
  );
}

function Frame({ label, labels, series, tick, children }: ChartProps & { children: (geometry: { x0: number; plotWidth: number; y: (value: number) => number; width: number }) => React.ReactNode }) {
  const { ref, width } = useWidth();
  const { min, max, ticks } = scaleFor(series.flatMap((item) => item.values));
  const plotWidth = Math.max(0, width - MARGIN.left - MARGIN.right);
  const plotHeight = HEIGHT - MARGIN.top - MARGIN.bottom;
  const y = (value: number) => MARGIN.top + plotHeight - ((value - min) / (max - min)) * plotHeight;
  const slot = labels.length > 0 ? plotWidth / labels.length : 0;
  // Only as many month labels as fit side by side.
  const every = Math.max(1, Math.ceil(44 / Math.max(slot, 1)));
  return (
    <div className="chart" ref={ref}>
      <Legend series={series} />
      {width > 0 && (
        <svg width={width} height={HEIGHT} role="img" aria-label={label}>
          {ticks.map((value) => (
            <g key={value}>
              <line x1={MARGIN.left} x2={width - MARGIN.right} y1={y(value)} y2={y(value)} className={value === 0 ? 'chart-zero' : 'chart-grid'} />
              <text x={MARGIN.left - 6} y={y(value) + 4} textAnchor="end" className="chart-text">
                {tick(value)}
              </text>
            </g>
          ))}
          {labels.map((text, index) =>
            (labels.length - 1 - index) % every === 0 ? (
              <text key={index} x={MARGIN.left + slot * index + slot / 2} y={HEIGHT - 6} textAnchor="middle" className="chart-text">
                {text}
              </text>
            ) : null,
          )}
          {children({ x0: MARGIN.left, plotWidth, y, width })}
        </svg>
      )}
      {width === 0 && <div style={{ height: HEIGHT }} />}
    </div>
  );
}

/** Columns grouped by month, on one axis. */
export function MonthColumns(props: ChartProps) {
  const { labels, series, money } = props;
  const [active, setActive] = useState<number | null>(null);
  return (
    <div style={{ position: 'relative' }}>
      <Frame {...props}>
        {({ x0, plotWidth, y, width }) => {
          const slot = plotWidth / Math.max(labels.length, 1);
          const gap = 2;
          const bar = Math.max(2, Math.min(BAR_MAX, (slot * 0.7 - gap * (series.length - 1)) / series.length));
          const group = bar * series.length + gap * (series.length - 1);
          return (
            <>
              {labels.map((text, index) => {
                const left = x0 + slot * index + (slot - group) / 2;
                return (
                  <g key={text}>
                    {series.map((item, at) => {
                      const value = item.values[index] ?? 0;
                      const top = Math.min(y(value), y(0));
                      const height = Math.max(value === 0 ? 0 : 1, Math.abs(y(value) - y(0)));
                      return <rect key={item.name} x={left + at * (bar + gap)} y={top} width={bar} height={height} rx={Math.min(3, bar / 2)} style={{ fill: `var(${item.color})` }} />;
                    })}
                    <rect
                      x={x0 + slot * index}
                      y={MARGIN.top}
                      width={slot}
                      height={HEIGHT - MARGIN.top - MARGIN.bottom}
                      className={active === index ? 'chart-hit chart-hit-on' : 'chart-hit'}
                      tabIndex={0}
                      role="presentation"
                      onPointerEnter={() => setActive(index)}
                      onPointerLeave={() => setActive(null)}
                      onFocus={() => setActive(index)}
                      onBlur={() => setActive(null)}
                    />
                  </g>
                );
              })}
              {active !== null && width > 0 ? (
                <foreignObject x={0} y={0} width={width} height={HEIGHT} style={{ pointerEvents: 'none', overflow: 'visible' }}>
                  <Tooltip x={x0 + slot * active + slot / 2} width={width} title={labels[active]!} rows={series.map((item) => ({ name: item.name, color: item.color, value: money(item.values[active] ?? 0) }))} />
                </foreignObject>
              ) : null}
            </>
          );
        }}
      </Frame>
    </div>
  );
}

/** Lines over time, on one axis, with a crosshair that finds the nearest point. */
export function Lines(props: ChartProps) {
  const { labels, series, money } = props;
  const [active, setActive] = useState<number | null>(null);
  return (
    <div style={{ position: 'relative' }}>
      <Frame {...props}>
        {({ x0, plotWidth, y, width }) => {
          const slot = plotWidth / Math.max(labels.length, 1);
          const px = (index: number) => x0 + slot * index + slot / 2;
          const nearest = (event: React.PointerEvent<SVGRectElement>) => {
            const box = event.currentTarget.getBoundingClientRect();
            setActive(Math.max(0, Math.min(labels.length - 1, Math.floor((event.clientX - box.left) / Math.max(slot, 1)))));
          };
          return (
            <>
              {series.map((item) => (
                <g key={item.name}>
                  <polyline points={item.values.map((value, index) => `${px(index)},${y(value)}`).join(' ')} fill="none" strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" style={{ stroke: `var(${item.color})` }} />
                  {item.values.length > 0 && <circle cx={px(item.values.length - 1)} cy={y(item.values.at(-1)!)} r={4} className="chart-dot" style={{ fill: `var(${item.color})` }} />}
                </g>
              ))}
              {active !== null && (
                <>
                  <line x1={px(active)} x2={px(active)} y1={MARGIN.top} y2={HEIGHT - MARGIN.bottom} className="chart-cross" />
                  {series.map((item) => (
                    <circle key={item.name} cx={px(active)} cy={y(item.values[active] ?? 0)} r={4} className="chart-dot" style={{ fill: `var(${item.color})` }} />
                  ))}
                </>
              )}
              <rect
                x={x0}
                y={MARGIN.top}
                width={plotWidth}
                height={HEIGHT - MARGIN.top - MARGIN.bottom}
                className="chart-hit"
                tabIndex={0}
                role="presentation"
                onPointerMove={nearest}
                onPointerLeave={() => setActive(null)}
                onFocus={() => setActive(labels.length - 1)}
                onBlur={() => setActive(null)}
                onKeyDown={(event) => {
                  if (event.key === 'ArrowLeft') setActive((at) => Math.max(0, (at ?? labels.length) - 1));
                  if (event.key === 'ArrowRight') setActive((at) => Math.min(labels.length - 1, (at ?? -1) + 1));
                }}
              />
              {active !== null && width > 0 ? (
                <foreignObject x={0} y={0} width={width} height={HEIGHT} style={{ pointerEvents: 'none', overflow: 'visible' }}>
                  <Tooltip x={px(active)} width={width} title={labels[active]!} rows={series.map((item) => ({ name: item.name, color: item.color, value: money(item.values[active] ?? 0) }))} />
                </foreignObject>
              ) : null}
            </>
          );
        }}
      </Frame>
    </div>
  );
}
