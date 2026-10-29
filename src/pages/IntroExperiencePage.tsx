import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { alpha, type Theme, useTheme } from '@mui/material/styles';
import {
  Box,
  Button,
  Stack,
  Typography,
  useMediaQuery,
} from '@mui/material';
import ArrowForwardIcon from '@mui/icons-material/ArrowForward';
import AutoGraphIcon from '@mui/icons-material/AutoGraph';
import CalendarMonthIcon from '@mui/icons-material/CalendarMonth';
import ForumOutlinedIcon from '@mui/icons-material/ForumOutlined';
import HubIcon from '@mui/icons-material/Hub';
import KeyIcon from '@mui/icons-material/Key';
import LockOutlinedIcon from '@mui/icons-material/LockOutlined';
import MemoryIcon from '@mui/icons-material/Memory';
import PsychologyIcon from '@mui/icons-material/Psychology';
import PublicIcon from '@mui/icons-material/Public';
import TimelineIcon from '@mui/icons-material/Timeline';
import TuneIcon from '@mui/icons-material/Tune';
import { useNavigate } from 'react-router-dom';
import { useLayoutHeaderActions } from '../components/layout/AppLayoutContext';

type ScenarioKey = 'pressure' | 'memory' | 'room';

type IntroTokens = {
  bg: string;
  paper: string;
  card: string;
  text: string;
  muted: string;
  faint: string;
  line: string;
  primary: string;
  primarySoft: string;
  amber: string;
  violet: string;
  ink: string;
};

const displayFont = '"Noto Serif SC", "Source Han Serif SC", "Songti SC", "SimSun", serif';
const bodyFont = '"Inter", "Noto Sans SC", "PingFang SC", "Microsoft YaHei", system-ui, sans-serif';
const monoFont = '"Roboto Mono", "SFMono-Regular", monospace';

const mindLayers = [
  ['0', '存在边界', 'EXISTENCE BOUNDARY', '属于哪个世界，能带着什么继续存在，不假装拥有不属于它的记忆、感知或秘密。', 'secondary'],
  ['1', '身份核心', 'IDENTITY CORE', '身份、性格、说话习惯、价值观、欲望、恐惧与执念。', 'primary'],
  ['2', '记忆连续', 'MEMORY CONTINUITY', '旧事、承诺、禁忌、误会、共同经历和成长节点。', 'primary'],
  ['3', '关系立场', 'RELATIONSHIP STANCE', '喜欢、信任、防备、依赖、竞争、亏欠、护短或厌烦。', 'amber'],
  ['4', '当前状态', 'CURRENT STATE', '情绪、疲惫、兴奋、压抑、想靠近、想回避或想争回主动权。', 'amber'],
  ['5', '房间态势', 'ROOM DYNAMICS', '主线、矛盾线、阵营压力、话题热度、世界活动和公开边界。', 'secondary'],
  ['6', '本轮意图', 'TURN INTENT', '接住、反驳、追问、打岔、维护、试探、退让、开玩笑或敷衍。', 'primary'],
  ['7', '表达形态', 'EXPRESSION SHAPE', '一句、半句、嘴硬、跑题、留白、直说、绕开，或把旧事轻轻提起。', 'neutral'],
] as const;

const scenarioData: Record<ScenarioKey, {
  label: string;
  userMessage: string;
  reply: string;
  activeLayers: string[];
  notes: string[];
}> = {
  pressure: {
    label: '公开压力',
    userMessage: '算了，别问了。',
    reply: '先别围着问。她想说的时候自然会说。',
    activeLayers: ['7', '6', '5', '3', '2', '1', '0'],
    notes: ['房间压力升高', '关系选择维护', '表达不替人作答'],
  },
  memory: {
    label: '旧事回来',
    userMessage: '今天想喝点清爽的。',
    reply: '那就少糖，冰一点。你上次全糖没喝完。',
    activeLayers: ['7', '6', '4', '3', '2', '1', '0'],
    notes: ['偏好被唤醒', '熟悉感生效', '旧事只轻轻提起'],
  },
  room: {
    label: '群聊转向',
    userMessage: '你们先把话说清楚。',
    reply: '吵归吵，先别把人也推走。话说完，再站边。',
    activeLayers: ['7', '6', '5', '4', '3', '1', '0'],
    notes: ['矛盾线变强', '先稳住边界', '不抹平冲突'],
  },
};

const memoryEvents = [
  ['03.12', '不喜欢太甜', '一句随口偏好', '偏好'],
  ['03.19', '被阿晚记住', '关系里的照顾方式', '关系'],
  ['04.02', '半杯推给她', '变成共同玩笑', '锚点'],
  ['04.18', '少糖柠檬茶', '自然回到建议里', '唤醒'],
] as const;

const capabilities = [
  ['多角色群聊', '不是轮流答题，而是让房间形成主线、压力和余波。', <ForumOutlinedIcon key="room" />],
  ['长期记忆与关系', '偏好、承诺、误会和共同梗会在合适的时候回来。', <MemoryIcon key="memory" />],
  ['一对一深度陪伴', '称呼、习惯、边界和照顾方式会随相处变化。', <HubIcon key="hub" />],
  ['角色世界延展', '日记、信件、活动、Agent 任务可以进入同一个角色生命线。', <AutoGraphIcon key="world" />],
] as const;

const channelModes = [
  ['公开群聊', 'PUBLIC ROOM', '看见房间态势、公开关系、阵营压力和当前主线。', <PublicIcon key="public" />],
  ['用户单聊', 'USER DIRECT', '保留更细的用户偏好、称呼、照顾方式和共同约定。', <PsychologyIcon key="direct" />],
  ['角色私聊', 'PRIVATE CHAT', '角色之间可以形成独立关系、秘密、误会和未完成张力。', <LockOutlinedIcon key="pair" />],
] as const;

const controlItems = [
  ['多模型接入', '为不同角色和场景选择合适模型：轻松闲聊、长文创作、复杂推理可以分开配置。', <KeyIcon key="model" />],
  ['深度思考开关', '日常聊天保持轻快；需要分析、推理或复杂决策时，再让模型多想一步。', <TuneIcon key="thinking" />],
  ['图片与附件', '在模型支持时，把截图、图片文字或文档内容带进同一段对话。', <ForumOutlinedIcon key="attachments" />],
  ['隐私与边界', '公开房间、用户单聊和角色私聊分开投影，不把不该公开的细节带到台面上。', <LockOutlinedIcon key="privacy" />],
  ['活动与日历', '约定、见面、纪念日和世界事件会成为角色后来还能想起的经历。', <CalendarMonthIcon key="calendar" />],
] as const;

function getIntroTokens(theme: Theme): IntroTokens {
  const isDark = theme.palette.mode === 'dark';
  const primary = '#A78B6D';
  return {
    bg: isDark ? '#0B0E14' : '#F5F4F0',
    paper: isDark ? '#0B0E14' : '#F5F4F0',
    card: isDark ? 'rgba(255,255,255,0.03)' : 'rgba(0,0,0,0.02)',
    text: isDark ? '#E5E7EB' : '#1F2937',
    muted: isDark ? 'rgba(255,255,255,0.6)' : 'rgba(0,0,0,0.6)',
    faint: isDark ? 'rgba(255,255,255,0.38)' : 'rgba(0,0,0,0.38)',
    line: isDark ? 'rgba(255,255,255,0.08)' : 'rgba(15,23,42,0.1)',
    primary,
    primarySoft: alpha(primary, isDark ? 0.18 : 0.12),
    amber: '#D4A373',
    violet: '#9B8EC4',
    ink: isDark ? '#0B0E14' : '#111827',
  };
}

function PageShell({ children, tokens }: { children: ReactNode; tokens: IntroTokens }) {
  return (
    <Box
      sx={{
        minHeight: '100%',
        color: tokens.text,
        fontFamily: bodyFont,
        overflow: 'hidden',
        backgroundColor: tokens.bg,
        '& *': { letterSpacing: 0 },
        '&::-webkit-scrollbar': { width: 6 },
        '&::-webkit-scrollbar-track': { background: 'transparent' },
        '&::-webkit-scrollbar-thumb': { background: 'rgba(255,255,255,0.15)' },
        '&::-webkit-scrollbar-thumb:hover': { background: 'rgba(255,255,255,0.3)' },
        '& @keyframes introWhisper': {
          '0%, 100%': { opacity: 0.38, transform: 'translateY(0)' },
          '50%': { opacity: 0.82, transform: 'translateY(-4px)' },
        },
        '& @keyframes introDraw': {
          from: { strokeDashoffset: 420 },
          to: { strokeDashoffset: 0 },
        },
        '& @keyframes introFadeUp': {
          from: { opacity: 0, transform: 'translateY(12px)' },
          to: { opacity: 1, transform: 'translateY(0)' },
        },
        '@media (prefers-reduced-motion: reduce)': {
          '& *, & *::before, & *::after': {
            animationDuration: '0.001ms !important',
            animationIterationCount: '1 !important',
            transitionDuration: '0.001ms !important',
          },
        },
      }}
    >
      {children}
    </Box>
  );
}

function Section({ children, id }: { children: ReactNode; id?: string }) {
  return (
    <Box id={id} component="section" sx={{ width: 'min(1200px, calc(100% - 40px))', mx: 'auto', py: { xs: 7, md: 11 }, borderTop: '1px solid var(--intro-line)' }}>
      {children}
    </Box>
  );
}

function SectionTitle({ kicker, title, description, tokens }: { kicker: string; title: string; description: string; tokens: IntroTokens }) {
  return (
    <Box sx={{ maxWidth: 760 }}>
      <Typography sx={{ color: tokens.primary, fontFamily: monoFont, fontSize: 11, fontWeight: 800, lineHeight: 1.4 }}>
        {kicker}
      </Typography>
      <Typography
        component="h2"
        sx={{
          mt: 1.25,
          color: tokens.text,
          fontFamily: displayFont,
          fontSize: { xs: 32, md: 50 },
          fontWeight: 800,
          lineHeight: 1.08,
        }}
      >
        {title}
      </Typography>
      <Typography sx={{ mt: 1.35, color: tokens.muted, fontSize: { xs: 15, md: 16.5 }, lineHeight: 1.78 }}>
        {description}
      </Typography>
    </Box>
  );
}

function LineCard({ children, color }: { children: ReactNode; color: string }) {
  return (
    <Box
      sx={{
        position: 'relative',
        p: { xs: 1.8, md: 2.1 },
        border: '1px solid var(--intro-line)',
        bgcolor: 'var(--intro-card)',
        borderRadius: 0.5,
        '&::before': {
          content: '""',
          position: 'absolute',
          left: 0,
          top: 0,
          bottom: 0,
          width: 2,
          bgcolor: color,
          opacity: 0.82,
          transition: 'box-shadow 260ms ease, width 260ms ease',
        },
        '&:hover': {
          borderColor: alpha(color, 0.55),
          bgcolor: 'rgba(255,255,255,0.04)',
          '&::before': { width: 3, boxShadow: `0 0 18px ${alpha(color, 0.22)}` },
        },
      }}
    >
      {children}
    </Box>
  );
}

function RoomConstellation({ tokens }: { tokens: IntroTokens }) {
  const nodes = [
    [130, 120, 8, '你'],
    [270, 70, 6, '阿晚'],
    [410, 145, 5, '涩涩'],
    [330, 260, 6, '老李'],
    [170, 270, 5, '房间'],
  ] as const;
  const lines = [[0, 1], [1, 2], [1, 3], [0, 4], [4, 3]] as const;

  return (
    <Box sx={{ position: 'relative', minHeight: { xs: 280, md: 430 }, color: tokens.primary }}>
      <Box
        component="svg"
        viewBox="0 0 540 360"
        aria-label="群聊呼吸示意"
        sx={{ width: '100%', height: '100%', display: 'block' }}
      >
        {lines.map(([from, to], index) => (
          <line
            key={`${from}-${to}`}
            x1={nodes[from][0]}
            y1={nodes[from][1]}
            x2={nodes[to][0]}
            y2={nodes[to][1]}
            stroke={alpha(tokens.primary, 0.34)}
            strokeWidth="1"
            strokeDasharray="6 9"
            style={{ animation: `introDraw 1.2s ease ${index * 120}ms both`, strokeDasharray: 420, strokeDashoffset: 420 }}
          />
        ))}
        {nodes.map(([x, y, r, label], index) => (
          <g key={label} style={{ animation: `introFadeUp 700ms ease ${index * 110}ms both` }}>
            <circle cx={x} cy={y} r={r + 18} fill={alpha(tokens.primary, 0.05)} />
            <circle cx={x} cy={y} r={r} fill={index === 0 ? tokens.amber : tokens.primary} />
            <text x={x} y={y + 34} textAnchor="middle" fill={tokens.muted} style={{ fontFamily: bodyFont, fontSize: 13, fontWeight: 700 }}>
              {label}
            </text>
          </g>
        ))}
      </Box>
      <Box sx={{ position: 'absolute', left: { xs: 4, md: 28 }, bottom: { xs: 4, md: 24 }, maxWidth: 300 }}>
        <Typography sx={{ color: tokens.faint, fontFamily: monoFont, fontSize: 11 }}>ROOM PRESSURE / MEMORY / RELATION</Typography>
        <Typography sx={{ mt: 0.7, color: tokens.text, fontSize: { xs: 18, md: 22 }, fontWeight: 850, lineHeight: 1.3 }}>
          房间不是背景板，它会改变角色下一句话的重量。
        </Typography>
      </Box>
    </Box>
  );
}

function Hero({ tokens, onStart, onCreate }: { tokens: IntroTokens; onStart: () => void; onCreate: () => void }) {
  return (
    <Box component="section" sx={{ width: 'min(1200px, calc(100% - 40px))', mx: 'auto', minHeight: { md: 'calc(100vh - 64px)' }, py: { xs: 6, md: 9 }, display: 'grid', gridTemplateColumns: { xs: '1fr', lg: '0.92fr 1.08fr' }, gap: { xs: 4, lg: 7 }, alignItems: 'center' }}>
      <Box>
        <Typography sx={{ color: tokens.primary, fontFamily: monoFont, fontSize: 11, fontWeight: 850 }}>SENSE MURMUR / DIGITAL CHARACTER LIFE</Typography>
        <Typography
          component="h1"
          sx={{
            mt: 2,
            color: tokens.text,
            fontFamily: displayFont,
            fontSize: { xs: 43, sm: 64, lg: 84 },
            fontWeight: 800,
            lineHeight: 0.98,
          }}
        >
          不是活着，
          <Box component="span" sx={{ display: 'block', color: tokens.primary, textShadow: `0 0 26px ${alpha(tokens.primary, 0.18)}`, animation: 'introWhisper 4s ease-in-out infinite' }}>
            是被活过。
          </Box>
        </Typography>
        <Typography sx={{ mt: 2.2, maxWidth: 640, color: tokens.muted, fontSize: { xs: 16, md: 18 }, lineHeight: 1.82 }}>
          生息让角色带着记忆、关系、情绪、欲望和自己的边界进入同一个房间。它们不是轮流答题，而是在相处中逐渐形成一个持续存在的自己。
        </Typography>
        <Stack direction="row" spacing={1.2} sx={{ mt: 3.2, flexWrap: 'wrap', gap: 1.2 }}>
          <Button variant="contained" endIcon={<ArrowForwardIcon />} onClick={onStart} sx={{ borderRadius: 0, px: 4, py: 1.5, bgcolor: tokens.primary, color: '#0B0E14', fontWeight: 500, boxShadow: 'none', '&:hover': { bgcolor: tokens.primary, filter: 'brightness(1.05)', boxShadow: 'none' } }}>
            开始一个房间
          </Button>
          <Button variant="outlined" onClick={onCreate} sx={{ borderRadius: 0, px: 4, py: 1.5, color: tokens.text, borderColor: alpha(tokens.text, 0.2), '&:hover': { borderColor: alpha(tokens.text, 0.42), bgcolor: 'rgba(255,255,255,0.035)' } }}>
            创建角色
          </Button>
        </Stack>
      </Box>
      <RoomConstellation tokens={tokens} />
    </Box>
  );
}

function PainSection({ tokens }: { tokens: IntroTokens }) {
  const pains = [
    ['下次见面又像第一次认识。', '角色需要带着过去继续相处。'],
    ['群聊变成轮流回答。', '房间需要有热度、站队和沉默。'],
    ['人设越写越长，话却越来越空。', '每轮发言前必须先形成当前心智。'],
  ] as const;

  return (
    <Section>
      <SectionTitle
        kicker="THE ABSENCE"
        title="空洞感不是因为回复不够长。"
        description="真正破坏沉浸的，是角色没有过去、没有关系位置，也没有此刻的犹豫、偏向和边界。"
        tokens={tokens}
      />
      <Box sx={{ mt: 4.4, display: 'grid', gridTemplateColumns: { xs: '1fr', md: 'repeat(3, minmax(0, 1fr))' }, gap: 1.2 }}>
        {pains.map(([title, body]) => (
          <LineCard key={title} color={tokens.primary}>
            <Typography sx={{ color: tokens.text, fontSize: { xs: 19, md: 21 }, fontWeight: 850, lineHeight: 1.35 }}>{title}</Typography>
            <Typography sx={{ mt: 1, color: tokens.muted, fontSize: 14, lineHeight: 1.68 }}>{body}</Typography>
          </LineCard>
        ))}
      </Box>
    </Section>
  );
}

function MindProjectionSection({ tokens, reducedMotion }: { tokens: IntroTokens; reducedMotion: boolean }) {
  const [scenario, setScenario] = useState<ScenarioKey>('pressure');
  const [selectedLayer, setSelectedLayer] = useState('7');
  const activeScenario = scenarioData[scenario];
  const selected = mindLayers.find(([index]) => index === selectedLayer) ?? mindLayers[mindLayers.length - 1];
  const visualLayers = [...mindLayers].reverse();
  const pyramid = { width: 640, height: 620, centerX: 320, baseHalfWidth: 300, stops: [0, 112, 190, 266, 340, 412, 482, 550, 620] };
  const toneColor = (tone: string) => {
    if (tone === 'secondary') return tokens.violet;
    if (tone === 'amber') return tokens.amber;
    if (tone === 'neutral') return tokens.faint;
    return tokens.primary;
  };

  return (
    <Section id="mind">
      <SectionTitle
        kicker="CHARACTER MIND PROJECTION"
        title="一句话出现之前，先有一个完整的“此刻的它”。"
        description="心智投影不是把人设贴进提示词，而是让身份、记忆、关系、状态、房间和表达在同一轮里互相制约。"
        tokens={tokens}
      />
      <Box sx={{ mt: 5, display: 'grid', gridTemplateColumns: { xs: '1fr', lg: '1.02fr 0.98fr' }, gap: { xs: 3.4, lg: 5.2 }, alignItems: 'start' }}>
        <Box sx={{ p: { xs: 1.5, md: 2 }, border: `1px solid ${tokens.line}`, bgcolor: tokens.ink }}>
          <Box sx={{ mx: 'auto', width: 'min(560px, 100%)' }}>
            <Box component="svg" viewBox={`0 0 ${pyramid.width} ${pyramid.height}`} role="img" aria-label="角色心智投影金字塔" sx={{ display: 'block', width: '100%', height: 'auto', overflow: 'visible' }}>
              <defs>
                <linearGradient id="mindPyramidEdge" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor={alpha(tokens.primary, 0.5)} />
                  <stop offset="56%" stopColor={alpha(tokens.amber, 0.38)} />
                  <stop offset="100%" stopColor={alpha(tokens.violet, 0.42)} />
                </linearGradient>
              </defs>
              {visualLayers.map(([index, title, technical, , tone], layerIndex) => {
                const isActive = activeScenario.activeLayers.includes(index);
                const isSelected = selectedLayer === index;
                const yTop = pyramid.stops[layerIndex];
                const yBottom = pyramid.stops[layerIndex + 1];
                const halfTop = (yTop / pyramid.height) * pyramid.baseHalfWidth;
                const halfBottom = (yBottom / pyramid.height) * pyramid.baseHalfWidth;
                const leftTop = pyramid.centerX - halfTop;
                const rightTop = pyramid.centerX + halfTop;
                const leftBottom = pyramid.centerX - halfBottom;
                const rightBottom = pyramid.centerX + halfBottom;
                const labelY = layerIndex === 0 ? yTop + (yBottom - yTop) * 0.66 : (yTop + yBottom) / 2;
                const color = toneColor(tone);
                return (
                  <g
                    key={index}
                    role="button"
                    tabIndex={0}
                    aria-label={`${index} ${title} ${technical}`}
                    onClick={() => setSelectedLayer(index)}
                    onMouseEnter={() => setSelectedLayer(index)}
                    onFocus={() => setSelectedLayer(index)}
                    onKeyDown={(event) => {
                      if (event.key === 'Enter' || event.key === ' ') {
                        event.preventDefault();
                        setSelectedLayer(index);
                      }
                    }}
                    style={{ cursor: 'pointer', outline: 'none' }}
                  >
                    <polygon
                      points={`${leftTop},${yTop} ${rightTop},${yTop} ${rightBottom},${yBottom} ${leftBottom},${yBottom}`}
                      fill={isActive ? alpha(color, isSelected ? 0.24 : 0.13) : 'rgba(255,255,255,0.035)'}
                      stroke={isActive || isSelected ? alpha(color, isSelected ? 0.92 : 0.5) : 'rgba(255,255,255,0.12)'}
                      strokeWidth={isSelected ? 2.4 : 1.2}
                      vectorEffect="non-scaling-stroke"
                      style={{ transition: reducedMotion ? 'none' : 'fill 220ms ease, stroke 220ms ease' }}
                    />
                    <text x={pyramid.centerX} y={labelY} textAnchor="middle" dominantBaseline="middle" fill="#E5E7EB" style={{ fontFamily: bodyFont, fontSize: layerIndex === 0 ? 18 : 20, fontWeight: 850, pointerEvents: 'none' }}>
                      <tspan fill={color} style={{ fontFamily: monoFont, fontSize: 13, fontWeight: 850 }}>{index}</tspan>
                      <tspan dx="10">{title}</tspan>
                    </text>
                  </g>
                );
              })}
              <polygon aria-hidden points={`${pyramid.centerX},0 ${pyramid.centerX + pyramid.baseHalfWidth},${pyramid.height} ${pyramid.centerX - pyramid.baseHalfWidth},${pyramid.height}`} fill="none" stroke="url(#mindPyramidEdge)" strokeWidth={1.8} vectorEffect="non-scaling-stroke" />
            </Box>
          </Box>
        </Box>
        <Box>
          <Stack direction="row" spacing={0.8} sx={{ flexWrap: 'wrap', gap: 0.8 }}>
            {(Object.keys(scenarioData) as ScenarioKey[]).map((key) => (
              <Button key={key} size="small" onClick={() => setScenario(key)} sx={{ borderRadius: 0, px: 1.5, minHeight: 36, color: scenario === key ? '#0B0E14' : tokens.text, bgcolor: scenario === key ? tokens.primary : 'transparent', border: `1px solid ${scenario === key ? tokens.primary : tokens.line}`, '&:hover': { borderColor: tokens.primary, bgcolor: scenario === key ? tokens.primary : 'rgba(255,255,255,0.035)' } }}>
                {scenarioData[key].label}
              </Button>
            ))}
          </Stack>
          <LineCard color={toneColor(selected[4])}>
            <Typography sx={{ color: tokens.primary, fontFamily: monoFont, fontSize: 11, fontWeight: 850 }}>LAYER {selected[0]} / {selected[2]}</Typography>
            <Typography sx={{ mt: 1, color: tokens.text, fontFamily: displayFont, fontSize: { xs: 25, md: 32 }, fontWeight: 800, lineHeight: 1.15 }}>{selected[1]}</Typography>
            <Typography sx={{ mt: 1, color: tokens.muted, fontSize: 14.5, lineHeight: 1.72 }}>{selected[3]}</Typography>
          </LineCard>
          <Box sx={{ mt: 1.2, p: { xs: 1.6, md: 2 }, border: `1px solid ${tokens.line}` }}>
            <Typography sx={{ color: tokens.faint, fontSize: 13 }}>用户说</Typography>
            <Typography sx={{ mt: 0.35, color: tokens.text, fontSize: { xs: 19, md: 22 }, fontWeight: 850, lineHeight: 1.35 }}>“{activeScenario.userMessage}”</Typography>
            <Typography sx={{ mt: 1.2, color: tokens.faint, fontSize: 13 }}>角色回</Typography>
            <Typography sx={{ mt: 0.35, color: tokens.text, fontFamily: displayFont, fontSize: { xs: 23, md: 29 }, fontWeight: 800, lineHeight: 1.35 }}>“{activeScenario.reply}”</Typography>
            <Stack spacing={0.65} sx={{ mt: 1.5 }}>
              {activeScenario.notes.map((note) => (
                <Typography key={note} sx={{ color: tokens.muted, fontSize: 13.2, lineHeight: 1.55 }}>· {note}</Typography>
              ))}
            </Stack>
          </Box>
        </Box>
      </Box>
    </Section>
  );
}

function MemoryTimeline({ tokens }: { tokens: IntroTokens }) {
  return (
    <Box sx={{ position: 'relative', mt: 4.5, display: 'grid', gap: 1.15, '&::before': { content: '""', position: 'absolute', left: { xs: 64, sm: 82 }, top: 18, bottom: 18, width: 1, bgcolor: alpha(tokens.primary, 0.34) } }}>
      {memoryEvents.map(([date, title, detail, tag], index) => {
        const color = index === 0 ? tokens.amber : index === 2 ? tokens.violet : tokens.primary;
        return (
          <Box key={title} sx={{ display: 'grid', gridTemplateColumns: { xs: '80px minmax(0, 1fr)', sm: '104px minmax(0, 1fr)' }, gap: { xs: 1.2, sm: 1.6 }, alignItems: 'stretch' }}>
            <Box sx={{ position: 'relative', minHeight: 104, display: 'flex', alignItems: 'center', zIndex: 1 }}>
              <Typography sx={{ width: { xs: 50, sm: 66 }, color, fontFamily: monoFont, fontSize: 11, fontWeight: 850, textAlign: 'right' }}>{date}</Typography>
              <Box sx={{ ml: 1.2, width: 14, height: 14, borderRadius: '50%', border: `2px solid ${color}`, bgcolor: tokens.bg, boxShadow: `0 0 0 5px ${alpha(color, 0.08)}` }} />
            </Box>
            <LineCard color={color}>
              <Stack direction="row" sx={{ justifyContent: 'space-between', alignItems: 'baseline', gap: 1 }}>
                <Typography sx={{ color, fontFamily: monoFont, fontSize: 10.5, fontWeight: 850 }}>MEMORY / 0{index + 1}</Typography>
                <Typography sx={{ color: tokens.faint, fontSize: 12 }}>{tag}</Typography>
              </Stack>
              <Typography sx={{ mt: 0.75, color: tokens.text, fontSize: { xs: 18, md: 20 }, fontWeight: 850, lineHeight: 1.3 }}>{title}</Typography>
              <Typography sx={{ mt: 0.45, color: tokens.muted, fontSize: 13.5, lineHeight: 1.62 }}>{detail}</Typography>
            </LineCard>
          </Box>
        );
      })}
    </Box>
  );
}

function RelationshipNetwork({ tokens }: { tokens: IntroTokens }) {
  return (
    <Box sx={{ mt: 4.5, display: 'grid', gridTemplateColumns: { xs: '1fr', md: '0.95fr 1.05fr' }, gap: { xs: 2.4, md: 4.5 }, alignItems: 'center' }}>
      <Box component="svg" viewBox="0 0 520 320" aria-label="关系网络图" sx={{ width: '100%', border: `1px solid ${tokens.line}`, bgcolor: tokens.card }}>
        {[
          [260, 160, 72, tokens.primary, '阿晚'],
          [105, 80, 48, tokens.amber, '你'],
          [420, 88, 42, tokens.violet, '涩涩'],
          [395, 245, 44, tokens.primary, '老李'],
          [120, 240, 38, tokens.faint, '房间'],
        ].map(([x, y, r, color, label], index) => (
          <g key={String(label)}>
            {index > 0 ? <path d={`M260 160 C ${x} 160, 260 ${y}, ${x} ${y}`} fill="none" stroke={alpha(String(color), 0.42)} strokeWidth={index === 1 ? 2.4 : 1.2} /> : null}
            <circle cx={Number(x)} cy={Number(y)} r={Number(r) / 2} fill={alpha(String(color), index === 0 ? 0.16 : 0.08)} stroke={String(color)} strokeWidth={index === 0 ? 2 : 1.3} />
            <text x={Number(x)} y={Number(y) + 5} textAnchor="middle" fill={tokens.text} style={{ fontFamily: bodyFont, fontSize: index === 0 ? 16 : 13, fontWeight: 850 }}>{label}</text>
          </g>
        ))}
      </Box>
      <Stack spacing={1.1}>
        {['用户会得到更细的照顾边界', '角色之间会保留试探、维护和误会', '公开房间会改变私密信息能说到哪里'].map((text, index) => (
          <LineCard key={text} color={index === 0 ? tokens.amber : index === 1 ? tokens.violet : tokens.primary}>
            <Typography sx={{ color: tokens.text, fontSize: 15.5, fontWeight: 800, lineHeight: 1.55 }}>{text}</Typography>
          </LineCard>
        ))}
      </Stack>
    </Box>
  );
}

function ContinuitySection({ tokens }: { tokens: IntroTokens }) {
  return (
    <Section>
      <SectionTitle
        kicker="MEMORY AND RELATION"
        title="经历不会停在消息里。"
        description="一句偏好、一次维护、一个共同玩笑，会被整理成能影响下一次相处的关系痕迹。"
        tokens={tokens}
      />
      <MemoryTimeline tokens={tokens} />
      <RelationshipNetwork tokens={tokens} />
    </Section>
  );
}

function ChannelProjectionSection({ tokens }: { tokens: IntroTokens }) {
  return (
    <Section>
      <SectionTitle
        kicker="SCENE PROJECTION"
        title="同一个角色，不同的可见世界。"
        description="生息不是把所有记忆一股脑塞进回复里。公开房间、用户单聊和角色私聊，会各自投影不同的边界、关系和可见信息。"
        tokens={tokens}
      />
      <Box sx={{ mt: 4.4, display: 'grid', gridTemplateColumns: { xs: '1fr', lg: '0.82fr 1.18fr' }, gap: { xs: 2.2, lg: 4.2 }, alignItems: 'stretch' }}>
        <Stack spacing={1.05}>
          {channelModes.map(([name, code, text, icon], index) => {
            const color = index === 1 ? tokens.amber : index === 2 ? tokens.violet : tokens.primary;
            return (
              <LineCard key={name} color={color}>
                <Stack direction="row" spacing={1.2} sx={{ alignItems: 'flex-start' }}>
                  <Box sx={{ color, pt: 0.15 }}>{icon}</Box>
                  <Box>
                    <Typography sx={{ color, fontFamily: monoFont, fontSize: 10.5, fontWeight: 850 }}>{code}</Typography>
                    <Typography sx={{ mt: 0.55, color: tokens.text, fontSize: { xs: 18, md: 20 }, fontWeight: 850, lineHeight: 1.28 }}>{name}</Typography>
                    <Typography sx={{ mt: 0.55, color: tokens.muted, fontSize: 13.5, lineHeight: 1.62 }}>{text}</Typography>
                  </Box>
                </Stack>
              </LineCard>
            );
          })}
        </Stack>
        <Box sx={{ border: `1px solid ${tokens.line}`, bgcolor: tokens.card, p: { xs: 1.8, md: 2.4 }, display: 'grid', alignContent: 'center' }}>
          <Box component="svg" viewBox="0 0 620 340" aria-label="场景投影示意" sx={{ width: '100%', height: 'auto' }}>
            <circle cx="310" cy="170" r="54" fill={alpha(tokens.primary, 0.08)} stroke={tokens.primary} strokeWidth="1.6" />
            <text x="310" y="166" textAnchor="middle" fill={tokens.text} style={{ fontFamily: bodyFont, fontSize: 16, fontWeight: 850 }}>角色本体</text>
            <text x="310" y="188" textAnchor="middle" fill={tokens.faint} style={{ fontFamily: monoFont, fontSize: 10 }}>ONE SELF</text>
            {[
              [116, 74, tokens.primary, '公开房间', '主线 / 压力'],
              [510, 92, tokens.amber, '用户单聊', '偏好 / 约定'],
              [498, 270, tokens.violet, '角色私聊', '秘密 / 张力'],
              [120, 258, tokens.faint, '世界事件', '日记 / 活动'],
            ].map(([x, y, color, title, subtitle]) => (
              <g key={String(title)}>
                <path d={`M310 170 C ${x} 170, 310 ${y}, ${x} ${y}`} fill="none" stroke={alpha(String(color), 0.38)} strokeWidth="1.2" strokeDasharray="5 8" />
                <circle cx={Number(x)} cy={Number(y)} r="34" fill={alpha(String(color), 0.07)} stroke={String(color)} strokeWidth="1.3" />
                <text x={Number(x)} y={Number(y) - 2} textAnchor="middle" fill={tokens.text} style={{ fontFamily: bodyFont, fontSize: 13, fontWeight: 850 }}>{title}</text>
                <text x={Number(x)} y={Number(y) + 16} textAnchor="middle" fill={tokens.faint} style={{ fontFamily: monoFont, fontSize: 9.5 }}>{subtitle}</text>
              </g>
            ))}
          </Box>
        </Box>
      </Box>
    </Section>
  );
}

function CapabilitySection({ tokens }: { tokens: IntroTokens }) {
  return (
    <Section>
      <SectionTitle
        kicker="WORLD RUNTIME"
        title="聊天只是入口，角色会继续生活。"
        description="房间、私聊、记忆、活动、日记、信件和 Agent 任务，共同组成一个持续运行的角色世界；模型、附件和隐私边界，则让这个世界可控。"
        tokens={tokens}
      />
      <Box sx={{ mt: 4.5, display: 'grid', gridTemplateColumns: { xs: '1fr', md: 'repeat(2, minmax(0, 1fr))' }, gap: 1.2 }}>
        {capabilities.map(([title, body, icon], index) => (
          <LineCard key={title} color={index === 1 ? tokens.amber : index === 2 ? tokens.violet : tokens.primary}>
            <Stack direction="row" spacing={1.2} sx={{ alignItems: 'flex-start' }}>
              <Box sx={{ color: index === 1 ? tokens.amber : index === 2 ? tokens.violet : tokens.primary, pt: 0.2 }}>{icon}</Box>
              <Box>
                <Typography sx={{ color: tokens.text, fontSize: { xs: 18, md: 21 }, fontWeight: 850, lineHeight: 1.3 }}>{title}</Typography>
                <Typography sx={{ mt: 0.75, color: tokens.muted, fontSize: 14, lineHeight: 1.68 }}>{body}</Typography>
              </Box>
            </Stack>
          </LineCard>
        ))}
      </Box>
      <Stack direction="row" sx={{ mt: 3, flexWrap: 'wrap', gap: 1 }}>
        {controlItems.map(([label, , icon], index) => (
          <Box key={label} sx={{ display: 'inline-flex', alignItems: 'center', gap: 0.75, px: 1, py: 0.72, border: `1px solid ${tokens.line}`, color: index === 1 ? tokens.amber : tokens.muted, fontSize: 13 }}>
            {icon}
            {label}
          </Box>
        ))}
      </Stack>
      <Box sx={{ mt: 2.6, display: 'grid', gridTemplateColumns: { xs: '1fr', md: 'repeat(5, minmax(0, 1fr))' }, gap: 1 }}>
        {controlItems.map(([label, body], index) => (
          <Box key={label} sx={{ borderTop: `1px solid ${index === 1 ? tokens.amber : tokens.line}`, pt: 1.15 }}>
            <Typography sx={{ color: tokens.text, fontSize: 14, fontWeight: 850, lineHeight: 1.35 }}>{label}</Typography>
            <Typography sx={{ mt: 0.55, color: tokens.muted, fontSize: 12.2, lineHeight: 1.55 }}>{body}</Typography>
          </Box>
        ))}
      </Box>
    </Section>
  );
}

function LetterPreview({ tokens }: { tokens: IntroTokens }) {
  const [open, setOpen] = useState(false);
  return (
    <Section>
      <Box sx={{ display: 'grid', gridTemplateColumns: { xs: '1fr', md: '0.82fr 1.18fr' }, gap: { xs: 2.6, md: 5 }, alignItems: 'center' }}>
        <SectionTitle
          kicker="EMOTIONAL ANCHOR"
          title="有些东西，不适合立刻说完。"
          description="角色可以把未完成的关系留到一封信、一篇日记、一次活动之后，再慢慢回到你面前。"
          tokens={tokens}
        />
        <Box
          role="button"
          tabIndex={0}
          onClick={() => setOpen((value) => !value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' || event.key === ' ') {
              event.preventDefault();
              setOpen((value) => !value);
            }
          }}
          sx={{ p: { xs: 2, md: 2.5 }, border: `1px solid ${alpha(tokens.amber, open ? 0.58 : 0.32)}`, bgcolor: alpha(tokens.amber, 0.045), cursor: 'pointer', transition: 'border-color 260ms ease, background-color 260ms ease' }}
        >
          <Typography sx={{ color: tokens.amber, fontFamily: monoFont, fontSize: 11, fontWeight: 850 }}>LAST LETTER</Typography>
          <Typography sx={{ mt: 1, color: tokens.text, fontFamily: displayFont, fontSize: { xs: 25, md: 34 }, fontWeight: 800, lineHeight: 1.18 }}>
            {open ? '“我不是忘了，只是那天没接住。”' : '最后一封信'}
          </Typography>
          <Typography sx={{ mt: 1.1, color: tokens.muted, fontSize: 14.5, lineHeight: 1.75 }}>
            {open ? '它没有把记忆当资料复述，而是把那次沉默变成了一句迟到的解释。' : '点击展开一段关系留下的余温。'}
          </Typography>
        </Box>
      </Box>
    </Section>
  );
}

export default function IntroExperiencePage() {
  const theme = useTheme<Theme>();
  const tokens = useMemo(() => getIntroTokens(theme), [theme]);
  const reducedMotion = useMediaQuery('(prefers-reduced-motion: reduce)');
  const navigate = useNavigate();
  const { setHideMobileBottomNav } = useLayoutHeaderActions();

  useEffect(() => {
    setHideMobileBottomNav(true);
    return () => setHideMobileBottomNav(false);
  }, [setHideMobileBottomNav]);

  return (
    <PageShell tokens={tokens}>
      <Box
        sx={{
          '--intro-line': tokens.line,
          '--intro-card': tokens.card,
        }}
      >
        <Hero tokens={tokens} onStart={() => navigate('/chats/create')} onCreate={() => navigate('/characters/create')} />
        <PainSection tokens={tokens} />
        <MindProjectionSection tokens={tokens} reducedMotion={reducedMotion} />
        <ContinuitySection tokens={tokens} />
        <ChannelProjectionSection tokens={tokens} />
        <CapabilitySection tokens={tokens} />
        <LetterPreview tokens={tokens} />
        <Box sx={{ width: 'min(1200px, calc(100% - 40px))', mx: 'auto', py: { xs: 7.5, md: 10 }, textAlign: 'center', borderTop: `1px solid ${tokens.line}` }}>
          <PsychologyIcon sx={{ color: tokens.primary, fontSize: 34 }} />
          <Typography component="h2" sx={{ mt: 1.6, color: tokens.text, fontFamily: displayFont, fontSize: { xs: 34, md: 54 }, fontWeight: 800, lineHeight: 1.08 }}>
            这些不是在设置里选的，
            <Box component="span" sx={{ display: 'block', color: tokens.primary }}>是在对话里长出来的。</Box>
          </Typography>
          <Typography sx={{ mt: 1.35, mx: 'auto', maxWidth: 660, color: tokens.muted, fontSize: 15, lineHeight: 1.78 }}>
            创建几个角色，给他们一个话题。谁会记得旧事，谁会改变语气，谁会把关系带到下一次相处里，都会在时间中显形。
          </Typography>
          <Stack direction="row" spacing={1.2} sx={{ mt: 2.8, flexWrap: 'wrap', gap: 1.2, justifyContent: 'center' }}>
            <Button variant="contained" endIcon={<ArrowForwardIcon />} onClick={() => navigate('/chats/create')} sx={{ borderRadius: 0, px: 4, py: 1.5, bgcolor: tokens.primary, color: '#0B0E14', fontWeight: 500, boxShadow: 'none', '&:hover': { bgcolor: tokens.primary, filter: 'brightness(1.05)', boxShadow: 'none' } }}>
              开始群聊
            </Button>
            <Button variant="outlined" onClick={() => navigate('/characters/create')} sx={{ borderRadius: 0, px: 4, py: 1.5, color: tokens.text, borderColor: alpha(tokens.text, 0.2), '&:hover': { borderColor: alpha(tokens.text, 0.42), bgcolor: 'rgba(255,255,255,0.035)' } }}>
              创建角色
            </Button>
          </Stack>
        </Box>
      </Box>
    </PageShell>
  );
}
