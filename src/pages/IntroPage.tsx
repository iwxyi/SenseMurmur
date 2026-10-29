import { useEffect, useRef, useState, type ComponentProps, type ReactNode } from 'react';
import { useTheme } from '@mui/material/styles';
import { Box, Button, Chip, Stack, Typography } from '@mui/material';
import PsychologyIcon from '@mui/icons-material/Psychology';
import HubIcon from '@mui/icons-material/Hub';
import MemoryIcon from '@mui/icons-material/Memory';
import ForumIcon from '@mui/icons-material/Forum';
import TimelineIcon from '@mui/icons-material/Timeline';
import VisibilityIcon from '@mui/icons-material/Visibility';
import ArrowForwardIcon from '@mui/icons-material/ArrowForward';
import CalendarMonthIcon from '@mui/icons-material/CalendarMonth';
import ExtensionIcon from '@mui/icons-material/Extension';
import KeyIcon from '@mui/icons-material/Key';
import PersonAddAlt1Icon from '@mui/icons-material/PersonAddAlt1';
import ForumOutlinedIcon from '@mui/icons-material/ForumOutlined';
import { useNavigate } from 'react-router-dom';
import { motion, reducedMotionDescendantSx } from '../styles/motion';
import { useLayoutHeaderActions } from '../components/layout/AppLayoutContext';

const accent = '#E5C07B';
const blue = '#E5C07B';
const bg = '#0A0A0F';
const panel = 'rgba(255,255,255,0.055)';
const border = 'rgba(255,255,255,0.12)';
const groupRevealOptions = { threshold: 0.04, rootMargin: '0px 0px 18% 0px' };

const navItems = [
  ['world', '这是什么'],
  ['memory', '旧事如何回来'],
  ['engine', '角色如何开口'],
  ['runtime', '房间如何运转'],
  ['craft', '开始相处'],
];

const proofRows = [
  {
    icon: <ForumIcon />,
    title: '一间会呼吸的房间',
    detail: '多个角色共享同一段正在发生的时间。接话、插话、沉默、维护、反驳，不是轮流发言，而是自然发生的对话。',
  },
  {
    icon: <MemoryIcon />,
    title: '记忆会沉下去，再浮上来',
    detail: '偏好、承诺、误会、共同经历，不会消失，只是暂时沉下去。在某个话题触碰到旧事时，它会自己浮上来，改变下一句话的语气。',
  },
  {
    icon: <HubIcon />,
    title: '关系不是一个分数',
    detail: '角色会记住你们之间发生过什么。亲近、信任、防备、亏欠——这些不是参数，是它开口前会感受到的重量。',
  },
  {
    icon: <PsychologyIcon />,
    title: '每一次开口，都是一次选择',
    detail: '生成回复前，角色会综合身份、记忆、关系、状态和房间态势，再决定说什么、说多少、用什么语气、要不要沉默。',
  },
];

const mockGroupChatLog: Array<{ type: 'time' | 'msg'; text?: string; sender?: '阿晚' | '老李' | '涩涩'; content?: string }> = [
  { type: 'time', text: '凌晨 01:23' },
  { type: 'msg', sender: '阿晚', content: '睡不着，有人在吗' },
  { type: 'time', text: '凌晨 01:25' },
  { type: 'msg', sender: '老李', content: '都几点了，明天不用上班？' },
  { type: 'msg', sender: '涩涩', content: '啧，老年人就是睡得早' },
  { type: 'msg', sender: '老李', content: '……我这叫养生' },
  { type: 'msg', sender: '阿晚', content: '今天不知道怎么了，就是睡不着' },
  { type: 'msg', sender: '老李', content: '那就起来喝杯水，别刷手机' },
  { type: 'msg', sender: '涩涩', content: '你上次也是这么说的，然后自己刷到了三点 [猫猫白眼.jpg]' },
  { type: 'msg', sender: '老李', content: '……你怎么知道' },
  { type: 'msg', sender: '涩涩', content: '因为那天我也没睡，你一直在群里发“还有人吗”，没人理你' },
  { type: 'msg', sender: '阿晚', content: '噗，我记得那次，涩涩当时也没理你' },
  { type: 'msg', sender: '涩涩', content: '我在装死，看不出来？' },
  { type: 'msg', sender: '阿晚', content: '有你们在真好，本来挺难过的' },
  { type: 'msg', sender: '涩涩', content: '啧，大半夜的别突然煽情' },
  { type: 'msg', sender: '涩涩', content: '他就是嘴贱。阿晚，没啥大不了的，睡一觉起来又是一条好汉' },
  { type: 'msg', sender: '老李', content: '对，明天太阳照常升起。快睡吧，我们在这儿' },
  { type: 'msg', sender: '阿晚', content: '嗯，晚安' },
  { type: 'msg', sender: '涩涩', content: '晚安' },
  { type: 'msg', sender: '老李', content: '晚安' },
];

const mockChatAvatars: Record<'阿晚' | '老李' | '涩涩', string> = {
  阿晚: '/mock-avatars/awan.png',
  老李: '/mock-avatars/laoli.png',
  涩涩: '/mock-avatars/sese.png',
};

const mockChatBubbleStyles: Record<'阿晚' | '老李' | '涩涩', {
  bg: string;
  borderColor: string;
  textColor: string;
  radius: string;
  shadow: string;
  borderStyle: 'solid' | 'dashed';
  notch?: 'left' | 'none';
}> = {
  阿晚: {
    bg: 'linear-gradient(135deg, rgba(150,182,255,0.22), rgba(150,182,255,0.12))',
    borderColor: 'rgba(150,182,255,0.40)',
    textColor: 'rgba(236,243,255,0.94)',
    radius: '16px 16px 16px 6px',
    shadow: '0 8px 22px rgba(120,150,220,0.16)',
    borderStyle: 'solid',
    notch: 'left',
  },
  老李: {
    bg: 'linear-gradient(135deg, rgba(229,192,123,0.22), rgba(229,192,123,0.12))',
    borderColor: 'rgba(229,192,123,0.42)',
    textColor: 'rgba(255,246,230,0.94)',
    radius: '8px 16px 16px 16px',
    shadow: '0 8px 20px rgba(170,130,70,0.16)',
    borderStyle: 'dashed',
    notch: 'none',
  },
  涩涩: {
    bg: 'linear-gradient(135deg, rgba(255,163,201,0.24), rgba(255,186,217,0.14))',
    borderColor: 'rgba(255,164,202,0.50)',
    textColor: 'rgba(255,241,248,0.96)',
    radius: '14px',
    shadow: '0 8px 18px rgba(255,136,184,0.20)',
    borderStyle: 'solid',
    notch: 'none',
  },
};

const metrics = [
  {
    label: '会话形态',
    value: '群聊、用户单聊、角色私聊',
    detail: '不同视角共享同一个角色本体，公开与私密各自留下痕迹。',
    mode: 'channels',
  },
  {
    label: '事实源',
    value: '消息、事件、关系账本、记忆流水，共同构成可追溯的因果链。',
    detail: '每一次互动都能回到来源，而不是只停留在一轮回复里。',
    mode: 'ledger',
  },
  {
    label: '场景底座',
    value: '从开放聊天到面试、课堂、圆桌、推理与桌游，不同场景有不同规则。',
    detail: '房间规则改变玩法，角色连续性仍然跟着它进入下一间房。',
    mode: 'scenes',
  },
  {
    label: '干预能力',
    value: '定向回应、导演模式、事件注入、议题重定向。必要的时候，你可以轻轻推一下剧情。',
    detail: '用户的推动会进入运行链路，成为世界里发生过的事。',
    mode: 'control',
  },
] as const;

const architectureNodes = [
  {
    title: '意图归一',
    caption: '精确感知',
    mode: 'intent',
    summary: '把用户的每句话拆解为意图、对象与情绪，让角色先理解再回应。',
    facets: ['对象识别', '意图分类', '动作指向'],
  },
  {
    title: '记忆分层',
    caption: '按需唤醒',
    mode: 'memory',
    summary: '短期对话、阶段经历与长期结论分层管理，在合适的时候自然唤醒。',
    facets: ['工作记忆', '阶段经历', '长期结论', '冷存档'],
  },
  {
    title: '立场沉淀',
    caption: '关系演化',
    mode: 'relationship',
    summary: '亲近、信任或防备不是固定分数，而是在互动中慢慢沉淀的立场。',
    facets: ['亲近', '信任', '威胁感', '能力认可'],
  },
  {
    title: '表达边界',
    caption: '分寸感知',
    mode: 'persona',
    summary: '综合身份、记忆与关系，决定此刻的语气、分寸和该说多少。',
    facets: ['语气分寸', '篇幅控制', '留白沉默'],
  },
] as const;

const runtimeSystemNodes = [
  {
    title: '事件因果',
    kicker: '每句话都会留下后果',
    summary: '每句话都会进入结构化事件流：消息、互动、关系变化、记忆候选和房间态势沿同一条链路沉淀。',
    points: ['消息生成', '互动识别', '关系变化', '记忆候选'],
    mode: 'events',
  },
  {
    title: '房间态势',
    kicker: '群体有自己的气候',
    summary: '房间会形成热度、凝聚、站队、围攻目标和话题漂移。角色回应的不只是上一句话，而是整个房间的空气。',
    points: ['互动热度', '联盟边界', '围观压力', '话题漂移'],
    mode: 'room',
  },
  {
    title: '矛盾推进',
    kicker: '冲突会寻找下一步',
    summary: '冲突不是关键词吵架，而是身份、面子、站队、误认和价值拉扯。系统会判断它下一步该逼回应、降温还是唤起旧账。',
    points: ['逼迫回应', '拉人站边', '旧账唤醒', '余波降温'],
    mode: 'conflict',
  },
  {
    title: '内在冲动',
    kicker: '开口前先有动机',
    summary: '角色在说话前会先形成冲动：证明自己、维护面子、安慰、回避、阴阳、岔开话题，甚至选择沉默。',
    points: ['想被看见', '维护体面', '安慰护短', '暂时沉默'],
    mode: 'impulse',
  },
  {
    title: '记忆消化',
    kicker: '旧事会沉降，也会回来',
    summary: '记忆不会无限堆叠。新证据会创建、强化、修正、合并或归档旧结论，重要经历才成为生命锚点。',
    points: ['创建', '强化', '修正', '归档'],
    mode: 'memory',
  },
  {
    title: '私密投影',
    kicker: '不同视角看到不同世界',
    summary: '群聊、用户单聊、角色私聊共享同一个角色本体，但事件会按公开、私有、双边和公开投影裁剪。',
    points: ['公开房间', '用户私有', '角色私聊', '公开投影'],
    mode: 'visibility',
  },
  {
    title: '角色证词',
    kicker: '经历最终会留下文字',
    summary: '诞生信、日记、成长总结和最后一封信都从真实经历、关系和内在余波里生成，像角色留下的自我叙事。',
    points: ['诞生信', '角色日记', '成长总结', '最后一封信'],
    mode: 'artifact',
  },
] as const;

function scrollToSection(id: string) {
  document.getElementById(id)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function Reveal({ children, delay = 0 }: { children: ReactNode; delay?: number }) {
  const ref = useRef<HTMLDivElement | null>(null);
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    const node = ref.current;
    if (!node) return;
    const observer = new IntersectionObserver(([entry]) => {
      if (entry.isIntersecting) {
        setVisible(true);
        observer.disconnect();
      }
    }, { threshold: 0.06, rootMargin: '0px 0px 16% 0px' });
    observer.observe(node);
    return () => observer.disconnect();
  }, []);

  return (
    <Box
      ref={ref}
      sx={{
        opacity: visible ? 1 : 0,
        transform: visible ? 'translateY(0)' : 'translateY(30px)',
        transition: 'opacity 720ms ease, transform 720ms ease',
        transitionDelay: `${delay}ms`,
      }}
    >
      {children}
    </Box>
  );
}

function GlassCard({ children, sx = {} }: { children: ReactNode; sx?: object }) {
  return (
    <Box
      sx={{
        border: `1px solid ${border}`,
        bgcolor: panel,
        backdropFilter: 'blur(18px)',
        borderRadius: 2,
        transition: 'transform 220ms ease, box-shadow 220ms ease, border-color 220ms ease, background-color 220ms ease',
        '&:hover': {
          transform: 'scale(1.02)',
          borderColor: 'rgba(229,192,123,0.42)',
          boxShadow: '0 18px 54px rgba(229,192,123,0.10)',
          bgcolor: 'rgba(255,255,255,0.075)',
        },
        ...sx,
      }}
    >
      {children}
    </Box>
  );
}

function useGroupReveal(options: IntersectionObserverInit = groupRevealOptions) {
  const ref = useRef<HTMLDivElement | null>(null);
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    const node = ref.current;
    if (!node) return;
    const observer = new IntersectionObserver(([entry]) => {
      if (entry.isIntersecting) {
        setVisible(true);
        observer.disconnect();
      }
    }, options);
    observer.observe(node);
    return () => observer.disconnect();
  }, [options]);

  const revealSx = (delay = 0) => ({
    opacity: visible ? 1 : 0,
    transform: visible ? 'translateY(0)' : 'translateY(28px)',
    transition: 'opacity 720ms ease, transform 720ms ease',
    transitionDelay: `${delay}ms`,
  });

  return { ref, revealSx };
}

function MockGroupChatSnapshot() {
  const { ref, revealSx } = useGroupReveal();
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const hostRef = useRef<HTMLDivElement | null>(null);
  const [visibleCount, setVisibleCount] = useState(0);
  const [typingIndex, setTypingIndex] = useState<number | null>(null);
  const [typedLength, setTypedLength] = useState(0);
  const [userScrolledUp, setUserScrolledUp] = useState(false);
  const [hasEnteredViewport, setHasEnteredViewport] = useState(false);

  useEffect(() => {
    const node = hostRef.current;
    if (!node) return;
    const observer = new IntersectionObserver(([entry]) => {
      if (entry.isIntersecting) {
        setHasEnteredViewport(true);
        observer.disconnect();
      }
    }, { threshold: 0.2, rootMargin: '0px 0px -12% 0px' });
    observer.observe(node);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    if (!hasEnteredViewport) return;
    let cancelled = false;
    const wait = (ms: number) => new Promise<void>((resolve) => {
      window.setTimeout(resolve, ms);
    });

    const runDemo = async () => {
      setVisibleCount(0);
      setTypingIndex(null);
      setTypedLength(0);

      for (let index = 0; index < mockGroupChatLog.length; index += 1) {
        if (cancelled) return;
        const item = mockGroupChatLog[index];
        setVisibleCount(index + 1);

        if (item.type === 'time') {
          await wait(280);
          continue;
        }

        const content = item.content || '';
        setTypingIndex(index);
        setTypedLength(0);
        await wait(120);
        for (let i = 1; i <= content.length; i += 1) {
          if (cancelled) return;
          setTypedLength(i);
          await wait(28);
        }
        setTypingIndex(null);
        await wait(620);
      }
    };

    void runDemo();
    return () => {
      cancelled = true;
    };
  }, [hasEnteredViewport]);

  useEffect(() => {
    const node = scrollRef.current;
    if (!node || userScrolledUp) return;
    node.scrollTo({ top: node.scrollHeight, behavior: 'smooth' });
  }, [visibleCount, typedLength, userScrolledUp]);

  return (
    <Box ref={ref} sx={{ mb: { xs: 5, md: 7 }, ...revealSx(0) }}>
      <Box sx={{ maxWidth: 760, mb: 2.25 }}>
        <Typography sx={{ color: accent, fontWeight: 740, letterSpacing: 1.2, fontSize: 13 }}>ROOM SAMPLE</Typography>
        <Typography sx={{ mt: 1, color: 'rgba(255,255,255,0.58)', lineHeight: 1.8, fontSize: 15.5 }}>
          这是最基础的房间形态：多个角色共享同一段时间，彼此接话、记住旧事，也把关系变化带到下一次对话。
        </Typography>
      </Box>
      <GlassCard sx={{ p: { xs: 1.4, sm: 1.8 }, borderRadius: 2.5, overflow: 'hidden' }}>
        <Box ref={hostRef} sx={{ borderRadius: 2, border: '1px solid rgba(255,255,255,0.10)', bgcolor: 'rgba(10,10,15,0.75)', overflow: 'hidden' }}>
          <Box sx={{ px: { xs: 1.4, sm: 1.9 }, py: 1.2, borderBottom: '1px solid rgba(255,255,255,0.10)', display: 'flex', alignItems: 'center', justifyContent: 'space-between', bgcolor: 'rgba(255,255,255,0.03)' }}>
            <Typography sx={{ color: '#F8F8FA', fontWeight: 760, fontSize: { xs: 14, sm: 15 } }}>生息小屋（QQ群：571886312）</Typography>
            <Typography sx={{ color: 'rgba(255,255,255,0.46)', fontSize: 12 }}>群聊记录</Typography>
          </Box>
          <Box
            ref={scrollRef}
            onScroll={() => {
              const node = scrollRef.current;
              if (!node) return;
              const nearBottom = node.scrollTop + node.clientHeight >= node.scrollHeight - 24;
              setUserScrolledUp(!nearBottom);
            }}
            sx={{ height: { xs: 280, sm: 340, md: 380 }, overflowY: 'auto', px: { xs: 1.2, sm: 1.6 }, py: 1.2, display: 'grid', alignContent: 'start', gap: 1 }}
          >
            {mockGroupChatLog.slice(0, visibleCount).map((item, index) => {
              if (item.type === 'time') {
                return (
                  <Typography key={`time-${index}`} sx={{ justifySelf: 'center', color: 'rgba(255,255,255,0.45)', fontSize: 11.5, lineHeight: 1.3, py: 0.2 }}>
                    {item.text}
                  </Typography>
                );
              }

              const style = mockChatBubbleStyles[item.sender as '阿晚' | '老李' | '涩涩'];
              const avatar = mockChatAvatars[item.sender as '阿晚' | '老李' | '涩涩'];
              return (
                <Box key={`msg-${index}`} sx={{ display: 'grid', gridTemplateColumns: '30px minmax(0, 1fr)', alignItems: 'start', columnGap: 0.8 }}>
                  <Box component="img" src={avatar} alt={item.sender} sx={{ width: 30, height: 30, borderRadius: '50%', objectFit: 'cover', border: '1px solid rgba(255,255,255,0.22)', boxShadow: '0 4px 10px rgba(0,0,0,0.28)' }} />
                  <Box sx={{ display: 'grid', gap: 0.35 }}>
                    <Typography sx={{ color: 'rgba(255,255,255,0.58)', fontSize: 12, fontWeight: 620 }}>{item.sender}</Typography>
                    <Box
                      sx={{
                        width: 'fit-content',
                        maxWidth: 'min(100%, 920px)',
                        px: 1.25,
                        py: 0.9,
                        borderRadius: style.radius,
                        border: '1px',
                        borderStyle: style.borderStyle,
                        borderColor: style.borderColor,
                        background: style.bg,
                        boxShadow: style.shadow,
                        color: style.textColor,
                        fontSize: 13.5,
                        lineHeight: 1.6,
                        whiteSpace: 'pre-wrap',
                        wordBreak: 'break-word',
                        position: 'relative',
                        '&::before': style.notch === 'left' ? {
                          content: '""',
                          position: 'absolute',
                          left: -6,
                          top: 10,
                          width: 10,
                          height: 10,
                          borderLeft: `1px solid ${style.borderColor}`,
                          borderBottom: `1px solid ${style.borderColor}`,
                          background: style.bg,
                          transform: 'rotate(45deg)',
                        } : undefined,
                      }}
                    >
                      {typingIndex === index ? (item.content || '').slice(0, typedLength) || ' ' : item.content}
                    </Box>
                  </Box>
                </Box>
              );
            })}
          </Box>
        </Box>
      </GlassCard>
    </Box>
  );
}

function EngineSection() {
  const { ref, revealSx } = useGroupReveal();

  return (
    <Box ref={ref} id="engine" sx={{ py: { xs: 5, md: 7 } }}>
      <Box sx={{ maxWidth: 760, mb: 3, ...revealSx(0) }}>
        <Typography sx={{ color: accent, fontWeight: 740, letterSpacing: 1.2, fontSize: 13 }}>TIME IMPRINTS</Typography>
        <Typography sx={{ mt: 1.5, fontWeight: 820, lineHeight: { xs: 1.14, md: 1.1 }, fontSize: { xs: 34, md: 54 }, color: '#F8F8FA' }}>
          <Box component="span" sx={{ color: accent }}>时间</Box>会留下凹痕。
        </Typography>
        <Typography sx={{ mt: 2, color: 'rgba(255,255,255,0.58)', lineHeight: 1.8, fontSize: 16 }}>
          每一轮开口，都是意图、关系、记忆、情绪和态势一起收束出来的。
        </Typography>
      </Box>
      <MindProjectionPyramidCard />
    </Box>
  );
}

function RuntimeSystemGlyph({ mode }: { mode: (typeof runtimeSystemNodes)[number]['mode'] }) {
  const cycleCount = mode === 'room' ? 5 : mode === 'impulse' ? 6 : 0;
  const [innerActiveIndex, setInnerActiveIndex] = useState(0);

  useEffect(() => {
    if (cycleCount === 0) return;
    const timer = window.setInterval(() => {
      setInnerActiveIndex((current) => (current + 1) % cycleCount);
    }, 900);
    return () => window.clearInterval(timer);
  }, [cycleCount]);

  if (mode === 'room') {
    return (
      <Box sx={{ position: 'relative', height: 260, display: 'grid', placeItems: 'center' }}>
        <Box sx={{ position: 'absolute', width: 206, height: 206, borderRadius: '50%', border: '1px solid rgba(255,255,255,0.10)', bgcolor: 'rgba(255,255,255,0.025)' }} />
        {[
          ['热度', 0, accent],
          ['凝聚', 72, blue],
          ['站队', 144, accent],
          ['围观', 216, blue],
          ['漂移', 288, accent],
        ].map(([label, angle, color], index) => (
          <Box key={label} sx={{ position: 'absolute', transform: `rotate(${angle}deg) translateY(-94px) rotate(-${angle}deg)`, display: 'grid', placeItems: 'center', width: 54, height: 54, borderRadius: '50%', border: `1px solid ${index === innerActiveIndex ? 'rgba(229,192,123,0.72)' : color === accent ? 'rgba(229,192,123,0.34)' : 'rgba(229,192,123,0.28)'}`, bgcolor: index === innerActiveIndex ? 'rgba(229,192,123,0.16)' : 'rgba(10,10,15,0.66)', color: index === innerActiveIndex ? '#F8F8FA' : 'rgba(255,255,255,0.78)', fontSize: 12, fontWeight: 760, boxShadow: index === innerActiveIndex ? '0 0 30px rgba(229,192,123,0.20)' : 'none', animation: 'systemBreath 5s ease-in-out infinite', animationDelay: `${index * 280}ms`, transition: 'border-color 260ms ease, background-color 260ms ease, box-shadow 260ms ease, color 260ms ease' }}>
            {label}
          </Box>
        ))}
        <Typography sx={{ color: '#F8F8FA', fontWeight: 820, fontSize: 28 }}>房间</Typography>
      </Box>
    );
  }

  if (mode === 'conflict') {
    return (
      <Box sx={{ height: 260, width: { xs: '94%', sm: '88%' }, mx: 'auto', display: 'grid', alignContent: 'center', gap: { xs: 1.55, sm: 1.75 } }}>
        {[
          ['误认错位', '逼回应'],
          ['面子竞争', '拉站边'],
          ['价值分歧', '升高筹码'],
          ['旧账回流', '带着余波降温'],
        ].map(([source, hook], index) => (
          <Box key={source} sx={{ display: 'grid', gridTemplateColumns: '1fr 44px 1fr', alignItems: 'center', gap: 1.15, opacity: 0.88, animation: 'systemSlide 4.8s ease-in-out infinite', animationDelay: `${index * 260}ms` }}>
            <Box sx={{ p: 1.1, borderRadius: 1.5, border: '1px solid rgba(255,255,255,0.10)', bgcolor: 'rgba(255,255,255,0.045)', color: 'rgba(255,255,255,0.70)', fontSize: 12, textAlign: 'center' }}>{source}</Box>
            <Box sx={{ height: 1, bgcolor: 'rgba(229,192,123,0.55)', boxShadow: '0 0 18px rgba(229,192,123,0.22)' }} />
            <Box sx={{ p: 1.1, borderRadius: 1.5, border: '1px solid rgba(229,192,123,0.22)', bgcolor: 'rgba(229,192,123,0.075)', color: '#F8F8FA', fontSize: 12, textAlign: 'center', fontWeight: 720 }}>{hook}</Box>
          </Box>
        ))}
      </Box>
    );
  }

  if (mode === 'impulse') {
    return (
      <Box sx={{ height: 260, position: 'relative', display: 'grid', placeItems: 'center' }}>
        <Box sx={{ width: 112, height: 112, borderRadius: '50%', border: '1px solid rgba(229,192,123,0.34)', display: 'grid', placeItems: 'center', color: '#F8F8FA', fontWeight: 820, bgcolor: 'rgba(229,192,123,0.08)' }}>冲动</Box>
        {['证明', '回避', '安慰', '维护', '调侃', '沉默'].map((label, index) => (
          <Box key={label} sx={{ position: 'absolute', transform: `rotate(${index * 60}deg) translateY(-96px) rotate(-${index * 60}deg)`, px: 1.1, py: 0.7, borderRadius: 999, border: index === innerActiveIndex ? '1px solid rgba(229,192,123,0.72)' : '1px solid rgba(255,255,255,0.12)', bgcolor: index === innerActiveIndex ? 'rgba(229,192,123,0.16)' : 'rgba(10,10,15,0.64)', color: index === innerActiveIndex ? '#F8F8FA' : 'rgba(255,255,255,0.72)', fontSize: 12, boxShadow: index === innerActiveIndex ? '0 0 26px rgba(229,192,123,0.18)' : 'none', animation: 'systemBreath 4.8s ease-in-out infinite', animationDelay: `${index * 220}ms`, transition: 'border-color 260ms ease, background-color 260ms ease, box-shadow 260ms ease, color 260ms ease' }}>{label}</Box>
        ))}
      </Box>
    );
  }

  if (mode === 'memory') {
    return (
      <Box sx={{ height: 260, width: { xs: '92%', sm: '86%' }, mx: 'auto', display: 'grid', alignContent: 'center', gap: { xs: 1.35, sm: 1.55 } }}>
        {['创建', '强化', '修正', '合并', '归档', '唤醒'].map((label, index) => (
          <Box key={label} sx={{ display: 'grid', gridTemplateColumns: { xs: '46px 1fr', sm: '52px 1fr' }, gap: 0.75, alignItems: 'center' }}>
            <Typography sx={{ color: index === 5 ? accent : 'rgba(255,255,255,0.82)', fontSize: 12.5, fontWeight: 780, textRendering: 'geometricPrecision' }}>{label}</Typography>
            <Box sx={{ height: 10, borderRadius: 999, bgcolor: 'rgba(255,255,255,0.06)', overflow: 'hidden' }}>
              <Box sx={{ width: `${38 + index * 9}%`, height: '100%', borderRadius: 999, bgcolor: index === 5 ? accent : 'rgba(229,192,123,0.72)', animation: 'systemBar 3.8s ease-in-out infinite', animationDelay: `${index * 180}ms` }} />
            </Box>
          </Box>
        ))}
      </Box>
    );
  }

  if (mode === 'visibility') {
    return (
      <Box sx={{ height: 260, position: 'relative', display: 'grid', placeItems: 'center' }}>
        {[
          ['群聊公开', 108, 'rgba(229,192,123,0.16)'],
          ['用户私有', 78, 'rgba(229,192,123,0.14)'],
          ['角色私聊', 50, 'rgba(255,255,255,0.10)'],
        ].map(([label, size, color], index) => (
          <Box key={label} sx={{ position: 'absolute', width: Number(size) * 2, height: Number(size) * 2, borderRadius: '50%', border: '1px solid rgba(255,255,255,0.12)', bgcolor: color, display: 'grid', placeItems: index === 2 ? 'center' : 'start center', pt: index === 2 ? 0 : 1.3, color: 'rgba(255,255,255,0.68)', fontSize: 12, animation: 'systemBreath 6s ease-in-out infinite', animationDelay: `${index * 360}ms` }}>{label}</Box>
        ))}
      </Box>
    );
  }

  if (mode === 'artifact') {
    const artifactCards = [
      { label: '诞生信', variant: 'birth' },
      { label: '日记', variant: 'diary' },
      { label: '成长总结', variant: 'growth' },
      { label: '最后一封信', variant: 'farewell' },
    ] as const;

    return (
      <Box sx={{ height: 260, display: 'grid', gridTemplateColumns: 'repeat(2, minmax(0, 1fr))', gap: { xs: 1.15, sm: 1.35 }, alignContent: 'center' }}>
        {artifactCards.map((item, index) => (
          <Box key={item.label} sx={{ minHeight: { xs: 104, sm: 108 }, p: 1.35, borderRadius: 1.5, border: '1px solid rgba(229,192,123,0.18)', bgcolor: 'rgba(255,255,255,0.045)', color: '#F8F8FA', position: 'relative', overflow: 'hidden', animation: 'systemFloatSmall 5.5s ease-in-out infinite', animationDelay: `${index * 260}ms` }}>
            {item.variant === 'birth' ? (
              <>
                <Box sx={{ position: 'absolute', left: 12, right: 18, top: 38, height: 1, bgcolor: 'rgba(255,255,255,0.12)' }} />
                <Box sx={{ position: 'absolute', left: 12, right: 40, top: 56, height: 1, bgcolor: 'rgba(255,255,255,0.09)' }} />
                <Box sx={{ position: 'absolute', right: 14, bottom: 14, width: 28, height: 28, borderRadius: '50%', border: '1px solid rgba(229,192,123,0.45)', bgcolor: 'rgba(229,192,123,0.10)', boxShadow: '0 0 18px rgba(229,192,123,0.14)' }} />
              </>
            ) : null}
            {item.variant === 'diary' ? (
              <>
                <Box sx={{ position: 'absolute', left: 0, top: 0, bottom: 0, width: 7, bgcolor: 'rgba(229,192,123,0.24)' }} />
                {[36, 52, 68].map((top) => (
                  <Box key={top} sx={{ position: 'absolute', left: 20, right: 14, top, height: 1, bgcolor: 'rgba(255,255,255,0.10)' }} />
                ))}
                <Typography sx={{ position: 'absolute', right: 13, bottom: 12, color: 'rgba(229,192,123,0.72)', fontSize: 11, fontWeight: 760 }}>DAY 17</Typography>
              </>
            ) : null}
            {item.variant === 'growth' ? (
              <>
                <Box sx={{ position: 'absolute', left: 14, right: 16, bottom: 22, height: 1, bgcolor: 'rgba(255,255,255,0.10)' }} />
                {[18, 35, 52, 69].map((left, barIndex) => (
                  <Box key={left} sx={{ position: 'absolute', left: `${left}%`, bottom: 22, width: 6, height: 16 + barIndex * 8, borderRadius: 999, bgcolor: barIndex === 3 ? 'rgba(229,192,123,0.72)' : 'rgba(255,255,255,0.14)' }} />
                ))}
                <Box sx={{ position: 'absolute', left: 18, right: 18, top: 44, height: 1, bgcolor: 'rgba(229,192,123,0.34)', transform: 'rotate(-10deg)' }} />
              </>
            ) : null}
            {item.variant === 'farewell' ? (
              <>
                <Box sx={{ position: 'absolute', right: 0, top: 0, width: 34, height: 34, bgcolor: 'rgba(229,192,123,0.12)', clipPath: 'polygon(0 0, 100% 0, 100% 100%)', borderLeft: '1px solid rgba(229,192,123,0.20)' }} />
                <Box sx={{ position: 'absolute', left: 14, right: 26, top: 42, height: 1, bgcolor: 'rgba(255,255,255,0.12)' }} />
                <Box sx={{ position: 'absolute', left: 14, right: 42, top: 60, height: 1, bgcolor: 'rgba(255,255,255,0.09)' }} />
                <Box sx={{ position: 'absolute', left: 14, bottom: 16, width: 42, height: 1, bgcolor: 'rgba(229,192,123,0.48)' }} />
              </>
            ) : null}
            <Typography sx={{ position: 'relative', fontSize: 13, fontWeight: 780 }}>{item.label}</Typography>
          </Box>
        ))}
      </Box>
    );
  }

  return (
    <Box sx={{ height: 260, display: 'grid', gridTemplateColumns: 'repeat(5, minmax(0, 1fr))', gap: { xs: 0.35, sm: 0.8 }, alignItems: 'center' }}>
      {['消息', '互动', '关系', '记忆', '下一轮'].map((label, index) => (
        <Box
          key={label}
          sx={{
            minHeight: 116,
            display: 'grid',
            gridTemplateColumns: '1fr',
            alignContent: 'center',
            alignItems: 'center',
            gap: 0.8,
            position: 'relative',
            transform: { xs: 'none', sm: index % 2 === 0 ? 'translateY(-16px)' : 'translateY(16px)' },
          }}
        >
          <Box sx={{ mx: 'auto', width: { xs: 34, sm: 42 }, height: { xs: 34, sm: 42 }, borderRadius: '50%', display: 'grid', placeItems: 'center', border: '1px solid rgba(255,255,255,0.13)', bgcolor: index === 2 ? 'rgba(229,192,123,0.86)' : 'rgba(255,255,255,0.055)', color: index === 2 ? '#0A0A0F' : 'rgba(255,255,255,0.78)', fontSize: { xs: 10, sm: 11 }, fontWeight: 760, animation: 'systemBreath 4.8s ease-in-out infinite', animationDelay: `${index * 170}ms`, position: 'relative', zIndex: 1 }}>{index + 1}</Box>
          <Typography sx={{ color: 'rgba(255,255,255,0.68)', textAlign: 'center', fontSize: { xs: 10.5, sm: 12 }, lineHeight: 1.25 }}>{label}</Typography>
          {index < 4 ? <Box sx={{ position: 'absolute', right: { xs: -7, sm: -12 }, top: { xs: 50, sm: index % 2 === 0 ? 72 : 40 }, width: { xs: 14, sm: 24 }, height: 1, bgcolor: 'rgba(229,192,123,0.40)' }} /> : null}
        </Box>
      ))}
    </Box>
  );
}

function RuntimeSystemSection() {
  const { ref, revealSx } = useGroupReveal();
  const [activeIndex, setActiveIndex] = useState(0);
  const [isInteracting, setIsInteracting] = useState(false);
  const active = runtimeSystemNodes[activeIndex];

  useEffect(() => {
    if (isInteracting) return;
    const timer = window.setInterval(() => {
      setActiveIndex((current) => (current + 1) % runtimeSystemNodes.length);
    }, 2600);
    return () => window.clearInterval(timer);
  }, [isInteracting]);

  return (
    <Box ref={ref} id="runtime" sx={{ py: { xs: 5, md: 7 } }}>
      <Box sx={{ maxWidth: 780, mb: 3, ...revealSx(0) }}>
        <Typography sx={{ color: accent, fontWeight: 740, letterSpacing: 1.2, fontSize: 13 }}>INNER CONTINUITY</Typography>
        <Typography sx={{ mt: 1.5, fontWeight: 830, lineHeight: { xs: 1.14, md: 1.1 }, fontSize: { xs: 34, md: 54 }, color: '#F8F8FA' }}>
          让它继续成为<Box component="span" sx={{ color: accent }}>自己</Box>。
        </Typography>
        <Typography sx={{ mt: 2, color: 'rgba(255,255,255,0.58)', lineHeight: 1.8, fontSize: 16 }}>
          如果一个角色没有身体，它还能凭什么像一个存在？Sense Murmur 用同一套角色本体承载群聊、单聊、角色私聊和未来的故事房，让不同房间里的经历继续汇到同一个它身上。
        </Typography>
      </Box>
      <Box sx={{ display: 'grid', gridTemplateColumns: { xs: '1fr', lg: '0.92fr 1.08fr' }, gap: { xs: 1.5, md: 2 }, alignItems: 'stretch', ...revealSx(120) }}>
        <Box
          onMouseEnter={() => setIsInteracting(true)}
          onMouseLeave={() => setIsInteracting(false)}
          onFocus={() => setIsInteracting(true)}
          onBlur={(event) => {
            if (!event.currentTarget.contains(event.relatedTarget)) setIsInteracting(false);
          }}
          sx={{ display: 'grid', gridTemplateColumns: 'repeat(2, minmax(0, 1fr))', gap: 1 }}
        >
          {runtimeSystemNodes.map((node, index) => {
            const selected = index === activeIndex;
            return (
              <Box
                key={node.title}
                component="button"
                type="button"
                onMouseEnter={() => setActiveIndex(index)}
                onFocus={() => setActiveIndex(index)}
                onClick={() => setActiveIndex(index)}
                sx={{
                  textAlign: 'left',
                  p: 1.35,
                  minHeight: 106,
                  borderRadius: 2,
                  border: '1px solid',
                  borderColor: selected ? 'rgba(229,192,123,0.46)' : 'rgba(255,255,255,0.11)',
                  bgcolor: selected ? 'rgba(229,192,123,0.095)' : 'rgba(255,255,255,0.04)',
                  color: '#F8F8FA',
                  cursor: 'pointer',
                  boxShadow: selected ? '0 14px 34px rgba(229,192,123,0.09)' : 'none',
                  transition: 'transform 220ms ease, border-color 220ms ease, background-color 220ms ease, box-shadow 220ms ease',
                  position: 'relative',
                  overflow: 'hidden',
                  '&::after': {
                    content: '""',
                    position: 'absolute',
                    left: 0,
                    top: 0,
                    bottom: 0,
                    width: 3,
                    bgcolor: selected ? accent : 'transparent',
                    transition: 'background-color 220ms ease',
                  },
                  '&:hover, &:focus-visible': {
                    outline: 'none',
                    transform: 'translateY(-2px)',
                    borderColor: 'rgba(229,192,123,0.48)',
                    bgcolor: 'rgba(229,192,123,0.10)',
                  },
                }}
              >
                <Typography sx={{ color: accent, fontSize: 11, fontWeight: 800, letterSpacing: 0.8 }}>{node.kicker}</Typography>
                <Typography sx={{ mt: 0.55, fontWeight: 800, fontSize: 18 }}>{node.title}</Typography>
                <Typography sx={{ mt: 0.65, color: 'rgba(255,255,255,0.52)', fontSize: 12.5, lineHeight: 1.55 }}>{node.points.slice(0, 2).join(' / ')}</Typography>
              </Box>
            );
          })}
        </Box>
        <GlassCard sx={{ p: { xs: 2, md: 2.5 }, height: { xs: 560, sm: 540, md: 500 }, overflow: 'hidden', position: 'relative' }}>
          <Box sx={{ position: 'absolute', inset: 0, border: '1px solid rgba(255,255,255,0.035)' }} />
          <Box sx={{ position: 'relative', display: 'grid', gridTemplateRows: 'auto 1fr auto', gap: 1.5, height: '100%' }}>
            <Box sx={{ minHeight: { xs: 142, sm: 130, md: 118 } }}>
              <Typography sx={{ color: accent, fontWeight: 780, fontSize: 13 }}>{active.kicker}</Typography>
              <Typography sx={{ mt: 0.5, color: '#F8F8FA', fontWeight: 820, fontSize: { xs: 28, md: 34 }, lineHeight: 1.08 }}>{active.title}</Typography>
              <Typography sx={{ mt: 1, color: 'rgba(255,255,255,0.58)', lineHeight: 1.7, fontSize: 14.5 }}>{active.summary}</Typography>
            </Box>
            <Box sx={{ position: 'relative', minHeight: { xs: 276, sm: 286, md: 260 }, transform: 'translate3d(0, 0, 0)', willChange: 'transform', backfaceVisibility: 'hidden', contain: 'layout paint' }}>
              {runtimeSystemNodes.map((node) => {
                const selected = node.mode === active.mode;
                return (
                  <Box
                    key={node.mode}
                    sx={{
                      position: 'absolute',
                      inset: 0,
                      opacity: selected ? 1 : 0,
                      transform: selected ? 'translate3d(0, 0, 0)' : 'translate3d(0, 6px, 0)',
                      transition: 'opacity 340ms ease, transform 420ms cubic-bezier(0.2, 0.8, 0.2, 1)',
                      willChange: 'opacity, transform',
                      backfaceVisibility: 'hidden',
                      contain: 'layout paint',
                    }}
                  >
                    <RuntimeSystemGlyph mode={node.mode} />
                  </Box>
                );
              })}
            </Box>
            <Stack direction="row" spacing={0.7} sx={{ minHeight: { xs: 56, md: 26 }, alignContent: 'flex-start', flexWrap: 'wrap', gap: 0.7 }}>
              {active.points.map((point) => (
                <Chip key={point} size="small" label={point} sx={{ height: 24, color: 'rgba(255,255,255,0.76)', bgcolor: 'rgba(255,255,255,0.055)', border: '1px solid rgba(255,255,255,0.10)', '& .MuiChip-label': { px: 0.9, fontSize: 11.5 } }} />
              ))}
            </Stack>
          </Box>
        </GlassCard>
      </Box>
    </Box>
  );
}

function MindProjectionPyramidCard() {
  const layers = [
    ['0', '我在', '角色对自身存在形式、公开与私密边界、能说与不该说之事的底层感知。', '226,194,142'],
    ['1', '我是谁', '身份、性格、说话习惯、价值观、欲望、恐惧和执念先构成基本方向。', '229,184,123'],
    ['2', '我记得什么', '和用户、其他角色、房间共同经历有关的旧事、承诺、误会和成长被带入判断。', '217,172,112'],
    ['3', '我与你的关系', '喜欢、信任、防备、依赖、竞争、亏欠、护短或厌烦会改变同一句话的温度。', '205,158,103'],
    ['4', '大家现在的状态', '情绪、疲惫、兴奋、压抑、想靠近、想回避或想争主动权会改变当下表达。', '194,147,98'],
    ['5', '群里正在发生什么', '主线、矛盾线、阵营压力、话题热度、谁被维护或围攻，会形成公开场合的空气。', '184,137,94'],
    ['6', '这一次，我想做什么', '接住、反驳、追问、打岔、维护、试探、退让、玩笑或敷衍，会先成为这一轮的动作。', '174,128,91'],
    ['7', '最后我说出口的那句话', '真人不会每条都完整表达。有时一句、半句、跑题、嘴硬、留白，都是表达的一部分。', '164,119,88'],
  ] as const;
  const [activeLayer, setActiveLayer] = useState<(typeof layers)[number]>(layers[0]);
  const visualLayers = layers;

  return (
    <Reveal delay={450}>
      <GlassCard sx={{ p: { xs: 2, md: 2.5 } }}>
        <Typography sx={{ color: accent, fontWeight: 780, letterSpacing: 1.1, fontSize: 13 }}>心智投影</Typography>
        <Box sx={{ mt: 1.8, display: 'grid', gridTemplateColumns: { xs: '1fr', md: '1.08fr 0.92fr' }, gap: { xs: 2, md: 2.4 }, alignItems: 'center' }}>
          <Box sx={{ display: 'grid', gap: 0.36 }}>
          {visualLayers.map((layer, index) => {
            const [level, title, detail] = layer;
            const widthStep = 11.5;
            const topWidth = index * widthStep;
            const bottomWidth = (index + 1) * widthStep;
            const leftTop = 50 - topWidth / 2;
            const rightTop = 50 + topWidth / 2;
            const leftBottom = 50 - bottomWidth / 2;
            const rightBottom = 50 + bottomWidth / 2;
            const active = activeLayer[0] === level;
            const tone = layer[3];
            const textWidth = Math.min(78, Math.max(24, bottomWidth + 16));
            return (
              <Box
                key={level}
                component="button"
                type="button"
                onMouseEnter={() => setActiveLayer(layer)}
                onFocus={() => setActiveLayer(layer)}
                onClick={() => setActiveLayer(layer)}
                sx={{
                  mx: 'auto',
                  width: '100%',
                  minHeight: { xs: 42, sm: 48 },
                  display: 'grid',
                  placeItems: 'center',
                  textAlign: 'center',
                  px: 1.2,
                  border: 0,
                  cursor: 'pointer',
                  color: '#F8F8FA',
                  bgcolor: 'transparent',
                  transform: active ? 'translateY(-1px)' : 'translateY(0)',
                  transition: 'background-color 180ms ease, border-color 180ms ease, transform 180ms ease',
                  position: 'relative',
                  '&:hover, &:focus-visible': {
                    outline: 'none',
                    transform: 'translateY(-1px)',
                  },
                }}
              >
                <Box
                  aria-hidden
                  sx={{
                    position: 'absolute',
                    inset: 0,
                    pointerEvents: 'none',
                    borderTop: `1px solid ${active ? `rgba(${tone},0.70)` : 'rgba(255,255,255,0.13)'}`,
                    borderBottom: `1px solid ${active ? `rgba(${tone},0.48)` : 'rgba(255,255,255,0.08)'}`,
                    bgcolor: active ? `rgba(${tone},0.15)` : 'rgba(255,255,255,0.035)',
                    clipPath: `polygon(${leftTop}% 0, ${rightTop}% 0, ${rightBottom}% 100%, ${leftBottom}% 100%)`,
                    transition: 'background-color 180ms ease, border-color 180ms ease',
                  }}
                />
                <Box sx={{ position: 'relative', zIndex: 1, width: `${textWidth}%`, display: 'flex', justifyContent: 'center', alignItems: 'center', gap: { xs: 0.45, sm: 0.7 } }}>
                  <Typography component="span" sx={{ color: active ? `rgb(${tone})` : 'rgba(255,255,255,0.48)', fontWeight: 850, fontSize: 11.5 }}>{level}</Typography>
                  <Typography component="span" sx={{ color: active ? `rgb(${tone})` : '#F8F8FA', fontWeight: 820, fontSize: { xs: 13.2, sm: 14.5 }, lineHeight: 1.2 }}>{title}</Typography>
                </Box>
              </Box>
            );
          })}
          </Box>
          <Box sx={{ p: { xs: 1.7, md: 2 }, border: `1px solid rgba(${activeLayer[3]},0.22)`, bgcolor: `rgba(${activeLayer[3]},0.07)`, minHeight: { xs: 150, md: 220 }, display: 'grid', alignContent: 'center' }}>
            <Typography sx={{ color: `rgb(${activeLayer[3]})`, fontWeight: 850, fontSize: 13, letterSpacing: 1 }}>LAYER {activeLayer[0]}</Typography>
            <Typography sx={{ mt: 0.75, color: '#F8F8FA', fontWeight: 840, fontSize: { xs: 24, md: 30 }, lineHeight: 1.1 }}>{activeLayer[1]}</Typography>
            <Typography sx={{ mt: 1.15, color: 'rgba(255,255,255,0.62)', lineHeight: 1.78 }}>{activeLayer[2]}</Typography>
          </Box>
        </Box>
      </GlassCard>
    </Reveal>
  );
}

function MemoryContinuitySection() {
  const { ref, revealSx } = useGroupReveal();

  return (
    <Box
      ref={ref}
      id="memory"
      sx={{ py: { xs: 5, md: 7 }, display: 'grid', gridTemplateColumns: { xs: '1fr', lg: '0.9fr 1.1fr' }, gap: { xs: 3, md: 4 }, alignItems: 'start' }}
    >
      <Box sx={{ position: { lg: 'sticky' }, top: 110, ...revealSx(0) }}>
        <VisibilityIcon sx={{ color: accent, fontSize: 34, mb: 2 }} />
        <Typography sx={{ fontWeight: 820, lineHeight: { xs: 1.16, md: 1.12 }, fontSize: { xs: 32, md: 48 }, color: '#F8F8FA' }}>
          所谓灵魂，是明明在说现在，却听起来像在<Box component="span" sx={{ color: accent }}>回忆</Box>。
        </Typography>
        <Typography sx={{ mt: 2, color: 'rgba(255,255,255,0.58)', lineHeight: 1.85 }}>
          真正让人停下来的，不是某句回复有多聪明，而是某个角色忽然不像工具了。它知道自己为什么防备，知道谁曾站在它这边，也知道什么话，只能悄悄说。
        </Typography>
      </Box>
      <Box sx={{ display: 'grid', gridTemplateColumns: { xs: '1fr', sm: 'repeat(2, minmax(0, 1fr))' }, gap: 1.2, alignItems: 'stretch' }}>
        {proofRows.map((item, index) => (
          <Box key={item.title} sx={{ height: '100%', ...revealSx(110 + index * 80) }}>
            <GlassCard sx={{ p: { xs: 1.8, md: 2.1 }, minHeight: { xs: 178, sm: 204, md: 214 }, height: '100%', display: 'grid', alignContent: 'start' }}>
              <Box sx={{ width: 38, height: 38, borderRadius: 1.4, display: 'grid', placeItems: 'center', color: accent, border: '1px solid rgba(229,192,123,0.26)', bgcolor: 'rgba(229,192,123,0.07)', mb: 1.45, '& svg': { fontSize: 22 } }}>
                {item.icon}
              </Box>
              <Typography sx={{ color: '#F8F8FA', fontWeight: 790, fontSize: { xs: 18.5, md: 20 }, lineHeight: 1.25 }}>{item.title}</Typography>
              <Typography sx={{ mt: 1.05, color: 'rgba(255,255,255,0.58)', lineHeight: 1.72, fontSize: { xs: 14, md: 14.5 } }}>{item.detail}</Typography>
            </GlassCard>
          </Box>
        ))}
      </Box>
    </Box>
  );
}

function CraftMetricGlyph({ mode, active }: { mode: (typeof metrics)[number]['mode']; active: boolean }) {
  const glow = active ? 'rgba(229,192,123,0.72)' : 'rgba(255,255,255,0.18)';
  const soft = active ? 'rgba(229,192,123,0.18)' : 'rgba(255,255,255,0.055)';

  if (mode === 'channels') {
    return (
      <Box sx={{ position: 'relative', width: 66, height: 38 }}>
        {[0, 1, 2].map((index) => (
          <Box
            key={index}
            sx={{
              position: 'absolute',
              left: index * 19,
              top: index % 2 ? 13 : 0,
              width: 28,
              height: 28,
              borderRadius: '50%',
              border: `1px solid ${index === 1 ? glow : 'rgba(255,255,255,0.16)'}`,
              bgcolor: index === 1 ? soft : 'rgba(10,10,15,0.72)',
              boxShadow: active && index === 1 ? '0 0 22px rgba(229,192,123,0.18)' : 'none',
              transition: 'border-color 220ms ease, background-color 220ms ease, box-shadow 220ms ease',
            }}
          />
        ))}
      </Box>
    );
  }

  if (mode === 'ledger') {
    return (
      <Box sx={{ width: 66, display: 'grid', gap: 0.55 }}>
        {[0, 1, 2].map((index) => (
          <Box key={index} sx={{ display: 'grid', gridTemplateColumns: '10px 1fr', gap: 0.65, alignItems: 'center' }}>
            <Box sx={{ width: 8, height: 8, borderRadius: '50%', bgcolor: index === 1 ? glow : 'rgba(255,255,255,0.18)' }} />
            <Box sx={{ height: 2, borderRadius: 999, bgcolor: index === 1 ? glow : 'rgba(255,255,255,0.12)', transform: active ? 'scaleX(1)' : 'scaleX(0.72)', transformOrigin: 'left center', transition: 'transform 260ms ease, background-color 220ms ease' }} />
          </Box>
        ))}
      </Box>
    );
  }

  if (mode === 'scenes') {
    return (
      <Box sx={{ position: 'relative', width: 66, height: 38 }}>
        {[0, 1, 2].map((index) => (
          <Box key={index} sx={{ position: 'absolute', left: index * 16, top: index * 4, width: 34, height: 26, borderRadius: 1, border: `1px solid ${active && index === 2 ? glow : 'rgba(255,255,255,0.14)'}`, bgcolor: active && index === 2 ? soft : 'rgba(10,10,15,0.74)', transform: active ? `translateY(${-index}px)` : 'none', transition: 'transform 240ms ease, border-color 220ms ease, background-color 220ms ease' }} />
        ))}
      </Box>
    );
  }

  return (
    <Box sx={{ position: 'relative', width: 66, height: 38, display: 'grid', placeItems: 'center' }}>
      <Box sx={{ width: 38, height: 38, borderRadius: '50%', border: `1px solid ${glow}`, bgcolor: soft, display: 'grid', placeItems: 'center', transition: 'border-color 220ms ease, background-color 220ms ease' }}>
        <Box sx={{ width: 12, height: 12, borderRadius: '50%', bgcolor: active ? accent : 'rgba(255,255,255,0.24)' }} />
      </Box>
      {active ? <Box sx={{ position: 'absolute', inset: 2, borderRadius: '50%', border: '1px solid rgba(229,192,123,0.22)', animation: 'metricRipple 1.8s ease-out infinite' }} /> : null}
    </Box>
  );
}

function CraftContinuityPanel() {
  const [activeIndex, setActiveIndex] = useState(0);
  const [isInteracting, setIsInteracting] = useState(false);

  useEffect(() => {
    if (isInteracting) return;
    const timer = window.setInterval(() => {
      setActiveIndex((current) => (current + 1) % metrics.length);
    }, 2200);
    return () => window.clearInterval(timer);
  }, [isInteracting]);

  return (
    <Box
      onMouseEnter={() => setIsInteracting(true)}
      onMouseLeave={() => setIsInteracting(false)}
      onFocus={() => setIsInteracting(true)}
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget)) setIsInteracting(false);
      }}
      sx={{ display: 'grid', gridTemplateColumns: { xs: '1fr', sm: 'repeat(2, minmax(0, 1fr))' }, gap: 1.25 }}
    >
      {metrics.map((item, index) => {
        const selected = index === activeIndex;
        return (
          <Box
            key={item.label}
            component="button"
            type="button"
            onMouseEnter={() => setActiveIndex(index)}
            onFocus={() => setActiveIndex(index)}
            onClick={() => setActiveIndex(index)}
            sx={{
              minHeight: { xs: 178, sm: 194 },
              p: 2,
              borderRadius: 2,
              border: '1px solid',
              borderColor: selected ? 'rgba(229,192,123,0.44)' : 'rgba(255,255,255,0.10)',
              bgcolor: selected ? 'rgba(229,192,123,0.075)' : 'rgba(10,10,15,0.42)',
              color: '#F8F8FA',
              textAlign: 'left',
              cursor: 'pointer',
              position: 'relative',
              overflow: 'hidden',
              boxShadow: selected ? '0 18px 44px rgba(229,192,123,0.08)' : 'none',
              transform: selected ? 'translateY(-2px)' : 'translateY(0)',
              transition: 'transform 220ms ease, border-color 220ms ease, background-color 220ms ease, box-shadow 220ms ease',
              '&::before': {
                content: '""',
                position: 'absolute',
                left: 0,
                right: 0,
                top: 0,
                height: 2,
                bgcolor: selected ? accent : 'rgba(255,255,255,0.08)',
                transform: selected ? 'scaleX(1)' : 'scaleX(0.22)',
                transformOrigin: 'left center',
                transition: 'transform 260ms ease, background-color 220ms ease',
              },
              '&:hover, &:focus-visible': {
                outline: 'none',
                borderColor: 'rgba(229,192,123,0.48)',
                bgcolor: 'rgba(229,192,123,0.085)',
                transform: 'translateY(-2px)',
              },
            }}
          >
            <Box sx={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 1.5 }}>
              <Box>
                <Typography sx={{ color: accent, fontSize: 12, fontWeight: 780 }}>{String(index + 1).padStart(2, '0')} · {item.label}</Typography>
                <Typography sx={{ mt: 1, color: 'rgba(255,255,255,0.80)', lineHeight: 1.62, fontWeight: 700 }}>{item.value}</Typography>
              </Box>
              <CraftMetricGlyph mode={item.mode} active={selected} />
            </Box>
            <Typography sx={{ mt: 1.45, color: selected ? 'rgba(255,255,255,0.62)' : 'rgba(255,255,255,0.42)', lineHeight: 1.7, fontSize: 13.2, transition: 'color 220ms ease' }}>
              {item.detail}
            </Typography>
          </Box>
        );
      })}
    </Box>
  );
}

function ArchitectureGlyphLayer({ mode }: { mode: (typeof architectureNodes)[number]['mode'] }) {
  if (mode === 'relationship') {
    return (
      <Box sx={{ position: 'absolute', inset: 14, display: 'grid', placeItems: 'center' }}>
        <svg viewBox="0 0 160 160" width="100%" height="100%" aria-hidden="true">
          <circle cx="80" cy="80" r="64" fill="none" stroke="rgba(255,255,255,0.10)" />
          <circle cx="80" cy="80" r="48" fill="none" stroke="rgba(255,255,255,0.07)" />
          <circle cx="80" cy="80" r="31" fill="rgba(10,10,15,0.86)" stroke="rgba(255,255,255,0.10)" />
          {[
            ['80', '11', '亲近'],
            ['149', '80', '信任'],
            ['80', '149', '威胁'],
            ['11', '80', '认可'],
          ].map(([x, y, label]) => (
            <g key={label}>
              <line x1="80" y1="80" x2={x} y2={y} stroke="rgba(255,255,255,0.10)" />
              <text x={x} y={y} fill="rgba(255,255,255,0.62)" fontSize="8.5" textAnchor="middle" dominantBaseline="middle">{label}</text>
            </g>
          ))}
          <polygon points="80,28 125,71 96,130 38,88" fill="rgba(229,192,123,0.13)" stroke={accent} strokeWidth="1.6">
            <animate attributeName="points" dur="5.8s" repeatCount="indefinite" values="80,28 125,71 96,130 38,88;80,22 118,66 103,135 43,94;80,28 125,71 96,130 38,88" />
          </polygon>
        </svg>
      </Box>
    );
  }

  if (mode === 'memory') {
    return (
      <Box sx={{ position: 'absolute', inset: 12, display: 'grid', placeItems: 'center' }}>
        {[0, 1, 2, 3].map((index) => (
          <Box
            key={index}
            sx={{
              position: 'absolute',
              width: `${50 + index * 22}%`,
              aspectRatio: '1 / 1',
              borderRadius: '50%',
              border: '1px solid rgba(229,192,123,0.18)',
              animation: 'introOrbit 9s linear infinite',
              animationDelay: `${index * -1.1}s`,
              '&::after': {
                content: '""',
                position: 'absolute',
                top: -3,
                left: '50%',
                width: 6,
                height: 6,
                borderRadius: '50%',
                bgcolor: index === 3 ? blue : accent,
                boxShadow: '0 0 18px rgba(229,192,123,0.55)',
              },
            }}
          />
        ))}
      </Box>
    );
  }

  if (mode === 'persona') {
    return (
      <Box sx={{ position: 'absolute', inset: 20, display: 'grid', placeItems: 'center' }}>
        <svg viewBox="0 0 180 180" width="100%" height="100%" aria-hidden="true" style={{ position: 'absolute', inset: 0 }}>
          <circle cx="90" cy="90" r="68" fill="none" stroke="rgba(255,255,255,0.08)" strokeDasharray="2 7">
            <animateTransform attributeName="transform" type="rotate" from="0 90 90" to="360 90 90" dur="26s" repeatCount="indefinite" />
          </circle>
          {[
            [90, 22],
            [158, 90],
            [90, 158],
            [22, 90],
          ].map(([x, y], index) => (
            <line key={`${x}-${y}`} x1="90" y1="90" x2={x} y2={y} stroke={index % 2 ? 'rgba(229,192,123,0.18)' : 'rgba(229,192,123,0.20)'} strokeWidth="1.2">
              <animate attributeName="stroke-opacity" dur={`${3.8 + index * 0.4}s`} repeatCount="indefinite" values="0.18;0.62;0.18" />
            </line>
          ))}
          <path d="M90 30 C123 38 146 58 151 90 C142 120 120 144 90 151 C58 142 36 122 29 90 C38 57 59 39 90 30Z" fill="rgba(229,192,123,0.08)" stroke="rgba(229,192,123,0.24)" strokeWidth="1.3">
            <animate attributeName="d" dur="7.2s" repeatCount="indefinite" values="M90 30 C123 38 146 58 151 90 C142 120 120 144 90 151 C58 142 36 122 29 90 C38 57 59 39 90 30Z;M90 26 C119 44 151 62 146 90 C150 121 118 138 90 155 C56 138 33 121 34 90 C30 58 62 44 90 26Z;M90 30 C123 38 146 58 151 90 C142 120 120 144 90 151 C58 142 36 122 29 90 C38 57 59 39 90 30Z" />
          </path>
        </svg>
        {['核心', '防御', '渴望', '语气'].map((label, index) => (
          <Box
            key={label}
            sx={{
              position: 'absolute',
              width: 42,
              height: 42,
              borderRadius: '50%',
              display: 'grid',
              placeItems: 'center',
              transform: `rotate(${index * 90}deg) translateY(-76px) rotate(${-index * 90}deg)`,
              border: '1px solid rgba(255,255,255,0.14)',
              color: index % 2 ? 'rgba(255,255,255,0.74)' : '#0A0A0F',
              bgcolor: index % 2 ? 'rgba(10,10,15,0.64)' : 'rgba(229,192,123,0.86)',
              boxShadow: index % 2 ? '0 0 18px rgba(229,192,123,0.16)' : '0 0 20px rgba(229,192,123,0.28)',
              fontSize: 11,
              fontWeight: 760,
              animation: 'personaBreath 4.8s ease-in-out infinite',
              animationDelay: `${index * 420}ms`,
            }}
          >
            {label}
          </Box>
        ))}
      </Box>
    );
  }

  return (
    <Box sx={{ position: 'absolute', inset: 18, display: 'grid', placeItems: 'center' }}>
      {['识别', '锁定', '生成', '验收'].map((label, index) => (
        <Box
          key={label}
          sx={{
            position: 'absolute',
            left: `${8 + index * 24}%`,
            top: index % 2 === 0 ? '25%' : '62%',
            width: 42,
            height: 42,
            borderRadius: '50%',
            display: 'grid',
            placeItems: 'center',
            color: index === 2 ? '#0A0A0F' : 'rgba(255,255,255,0.76)',
            bgcolor: index === 2 ? accent : 'rgba(255,255,255,0.06)',
            border: '1px solid rgba(255,255,255,0.12)',
            fontSize: 11,
            fontWeight: 760,
            animation: 'introPulse 2.8s ease-in-out infinite',
            animationDelay: `${index * 170}ms`,
          }}
        >
          {label}
        </Box>
      ))}
    </Box>
  );
}

function ArchitectureGlyph({ mode }: { mode: (typeof architectureNodes)[number]['mode'] | null }) {
  return (
    <Box sx={{ position: 'absolute', inset: 0, pointerEvents: 'none' }}>
      {architectureNodes.map((node) => {
        const active = mode !== null && node.mode === mode;
        return (
          <Box
            key={node.mode}
            sx={{
              position: 'absolute',
              inset: 0,
              opacity: active ? 1 : 0,
              transform: active ? 'scale(1)' : 'scale(0.96)',
              filter: active ? 'blur(0px)' : 'blur(8px)',
              transition: 'opacity 420ms ease, transform 520ms cubic-bezier(0.2, 0.8, 0.2, 1), filter 420ms ease',
            }}
          >
            <ArchitectureGlyphLayer mode={node.mode} />
          </Box>
        );
      })}
    </Box>
  );
}

function HeroVisual() {
  const [activeIndex, setActiveIndex] = useState<number | null>(null);
  const [displayedIndex, setDisplayedIndex] = useState<number | null>(null);
  const [textVisible, setTextVisible] = useState(true);
  const activeNode = activeIndex === null ? null : architectureNodes[activeIndex];
  const displayedNode = displayedIndex === null ? null : architectureNodes[displayedIndex];
  const pipeline = [
    ['数字生命', '有记忆、有关系、会随时间改变。'],
    ['群聊生态', '多个角色在同一个房间，有自己的空气。'],
    ['自主决策', '自己决定何时开口、说什么、说多少。'],
  ];
  const detailAreaMinHeight = displayedNode ? { xs: 124, sm: 120 } : { xs: 124, sm: 120 };

  useEffect(() => {
    let transitionTimer: number | undefined;
    const timer = window.setTimeout(() => {
      if (activeIndex === displayedIndex) {
        setTextVisible(true);
        return;
      }
      setTextVisible(false);
      transitionTimer = window.setTimeout(() => {
        setDisplayedIndex(activeIndex);
        window.requestAnimationFrame(() => setTextVisible(true));
      }, 130);
    }, 0);
    return () => {
      window.clearTimeout(timer);
      if (transitionTimer !== undefined) window.clearTimeout(transitionTimer);
    };
  }, [activeIndex, displayedIndex]);

  const activateNode = (index: number) => {
    setActiveIndex(index);
  };

  const resetArchitecture = () => {
    setActiveIndex(null);
  };

  return (
    <GlassCard sx={{ p: { xs: 2, sm: 2.5 }, minHeight: { xs: 480, md: 560 }, position: 'relative', overflow: 'hidden' }}>
      <Box sx={{ position: 'absolute', inset: 0, border: '1px solid rgba(255,255,255,0.035)' }} />
      <Box sx={{ position: 'relative', height: '100%', display: 'grid', gridTemplateRows: 'auto auto auto', gap: { xs: 2.25, sm: 2.75 } }}>
        <Box
          onMouseLeave={resetArchitecture}
          onBlur={(event) => {
            if (!event.currentTarget.contains(event.relatedTarget)) resetArchitecture();
          }}
          sx={{ display: 'grid', gridTemplateColumns: 'repeat(2, minmax(0, 1fr))', gap: 1.25 }}
        >
          {architectureNodes.map((node, index) => {
            const active = activeIndex !== null && index === activeIndex;
            return (
            <Box
              key={node.title}
              component="button"
              type="button"
              onMouseEnter={() => activateNode(index)}
              onFocus={() => activateNode(index)}
              onClick={() => activateNode(index)}
              sx={{
                p: 1.5,
                textAlign: 'left',
                borderRadius: 2,
                border: '1px solid',
                borderColor: active ? 'rgba(229,192,123,0.54)' : 'rgba(255,255,255,0.12)',
                bgcolor: active ? 'rgba(229,192,123,0.11)' : 'rgba(10,10,15,0.52)',
                animation: 'introFloat 5.6s ease-in-out infinite',
                animationDelay: `${index * 240}ms`,
                cursor: 'pointer',
                transition: 'border-color 220ms ease, background-color 220ms ease, transform 220ms ease',
                '&:hover, &:focus-visible': {
                  outline: 'none',
                  transform: 'translateY(-2px)',
                  borderColor: 'rgba(229,192,123,0.64)',
                  bgcolor: 'rgba(229,192,123,0.12)',
                },
              }}
            >
              <Typography sx={{ color: '#F8F8FA', fontWeight: 760, fontSize: 15 }}>{node.title}</Typography>
              <Typography sx={{ color: active ? accent : 'rgba(255,255,255,0.48)', fontSize: 12, mt: 0.5, transition: 'color 220ms ease' }}>{node.caption}</Typography>
            </Box>
            );
          })}
        </Box>

        <Box sx={{ mx: 'auto', width: { xs: 220, sm: 282 }, display: 'grid', justifyItems: 'center' }}>
        <Box
          sx={{
            width: { xs: 188, sm: 230 },
            aspectRatio: '1 / 1',
            borderRadius: '50%',
            display: 'grid',
            placeItems: 'center',
            position: 'relative',
            border: '1px solid rgba(229,192,123,0.46)',
            bgcolor: 'rgba(255,255,255,0.035)',
            boxShadow: '0 0 80px rgba(0,0,0,0.16)',
            overflow: 'hidden',
            transition: 'box-shadow 260ms ease, border-color 260ms ease',
            animation: 'heroOrbBreath 5.8s ease-in-out infinite',
            backgroundImage: 'radial-gradient(circle at 34% 28%, rgba(255,255,255,0.10), transparent 28%), radial-gradient(circle at 50% 55%, rgba(229,192,123,0.10), transparent 58%)',
            '&::before, &::after': {
              content: '""',
              position: 'absolute',
              inset: 8,
              borderRadius: '50%',
              border: '2px solid rgba(229,192,123,0.36)',
              opacity: 0,
              transform: 'scale(0.58)',
              pointerEvents: 'none',
              zIndex: 0,
              animation: 'heroOrbWave 4.2s ease-out infinite',
            },
            '&::after': {
              inset: 26,
              borderColor: 'rgba(255,255,255,0.24)',
              animationDelay: '1.35s',
              animationDuration: '4.9s',
            },
          }}
        >
          <Box
            sx={{
              position: 'absolute',
              inset: 4,
              borderRadius: '50%',
              background: 'conic-gradient(from 20deg, transparent 0deg, rgba(229,192,123,0.20) 54deg, transparent 118deg, rgba(255,255,255,0.14) 188deg, transparent 260deg, rgba(229,192,123,0.16) 326deg, transparent 360deg)',
              filter: 'blur(1px)',
              opacity: 0.72,
              animation: 'heroOrbSpin 13s linear infinite',
              zIndex: 0,
            }}
          />
          <ArchitectureGlyph mode={activeNode?.mode ?? null} />
          <Box sx={{ position: 'absolute', inset: 20, borderRadius: '50%', border: '1px solid rgba(255,255,255,0.10)' }} />
          <Box
            sx={{
              position: 'relative',
              zIndex: 2,
              width: { xs: 136, sm: 166 },
              aspectRatio: '1 / 1',
              borderRadius: '50%',
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'center',
              justifyContent: 'center',
              textAlign: 'center',
              px: 1,
              bgcolor: 'rgba(10,10,15,0.82)',
              border: '1px solid rgba(255,255,255,0.11)',
              boxShadow: '0 0 36px rgba(10,10,15,0.64)',
              opacity: displayedNode ? 0 : 1,
              transform: displayedNode ? 'scale(0.92)' : 'scale(1)',
              transition: 'opacity 260ms ease, transform 320ms cubic-bezier(0.2, 0.8, 0.2, 1)',
            }}
          >
            <Box
              sx={{
                width: '100%',
                display: 'grid',
                justifyItems: 'center',
                textAlign: 'center',
                opacity: textVisible ? 1 : 0,
                transform: textVisible ? 'translateY(0)' : 'translateY(4px)',
                transition: 'opacity 220ms ease, transform 220ms ease',
              }}
            >
            <Typography sx={{ width: '100%', color: '#F8F8FA', fontWeight: 820, fontSize: { xs: 25, sm: 31 }, lineHeight: 1, letterSpacing: 0, textAlign: 'center', whiteSpace: 'nowrap' }}>生息</Typography>
            <Typography sx={{ width: '100%', color: accent, fontSize: 12, lineHeight: 1.15, mt: 0.75, letterSpacing: 1.8, textIndent: '1.8px', textAlign: 'center', whiteSpace: 'nowrap' }}>
              {displayedNode?.caption ?? 'Sense Murmur'}
            </Typography>
            </Box>
          </Box>
        </Box>
        </Box>

        <Box sx={{ position: 'relative', minHeight: detailAreaMinHeight, transition: 'min-height 340ms cubic-bezier(0.2, 0.8, 0.2, 1)' }}>
          <Box sx={{ position: 'absolute', inset: 0, display: 'grid', gridTemplateColumns: 'repeat(3, minmax(0, 1fr))', gap: { xs: 0.75, sm: 1 }, opacity: displayedNode ? 0 : 1, transform: displayedNode ? 'translateY(8px)' : 'translateY(0)', pointerEvents: displayedNode ? 'none' : 'auto', transition: 'opacity 260ms ease, transform 300ms ease' }}>
            {pipeline.map(([title, summary], index) => (
              <Box
                key={title}
                sx={{
                  p: { xs: 1.05, sm: 1.2 },
                  borderRadius: 1.5,
                  border: '1px solid rgba(255,255,255,0.10)',
                  color: 'rgba(255,255,255,0.72)',
                  bgcolor: 'rgba(255,255,255,0.035)',
                  position: 'relative',
                  overflow: 'hidden',
                }}
              >
                <Box sx={{ position: 'absolute', inset: 0, bgcolor: index === 1 ? 'rgba(229,192,123,0.08)' : 'transparent' }} />
                <Box sx={{ position: 'relative', minHeight: '100%', display: 'flex', flexDirection: 'column', justifyContent: 'center', alignItems: { xs: 'center', sm: 'stretch' }, textAlign: { xs: 'center', sm: 'left' }, pb: { xs: 0, sm: 0 } }}>
                  <Box>
                    <Typography sx={{ color: accent, fontSize: { xs: 20, sm: 14 }, fontWeight: 860, letterSpacing: { xs: 1.4, sm: 1.1 }, lineHeight: 1 }}>{String(index + 1).padStart(2, '0')}</Typography>
                    <Typography sx={{ mt: { xs: 1.45, sm: 0.48 }, fontSize: { xs: 17, sm: 15 }, fontWeight: 780, color: '#F8F8FA', lineHeight: { xs: 1.18, sm: 1.34 } }}>{title}</Typography>
                  </Box>
                  <Typography sx={{ mt: { xs: 1.65, sm: 0.6 }, mb: { xs: 0, sm: 0 }, fontSize: { xs: 11.6, sm: 12.5 }, lineHeight: 1.5, color: 'rgba(255,255,255,0.70)' }}>{summary}</Typography>
                </Box>
              </Box>
            ))}
          </Box>
          <Box
            sx={{
              position: 'absolute',
              inset: 0,
              p: { xs: 1.35, sm: 1.6 },
              borderRadius: 1.5,
              border: '1px solid rgba(255,255,255,0.10)',
              bgcolor: 'rgba(10,10,15,0.48)',
              backdropFilter: 'blur(14px)',
              opacity: displayedNode ? 1 : 0,
              transform: displayedNode ? 'translateY(0)' : 'translateY(8px)',
              pointerEvents: displayedNode ? 'auto' : 'none',
              transition: 'opacity 260ms ease, transform 300ms ease, border-color 220ms ease, background-color 220ms ease',
            }}
          >
            {displayedNode ? (
            <Box sx={{ height: '100%', display: 'grid', alignContent: { xs: 'start', sm: 'center' }, opacity: textVisible ? 1 : 0, transform: textVisible ? 'translateY(0)' : 'translateY(5px)', transition: 'opacity 220ms ease, transform 220ms ease' }}>
            <Typography sx={{ color: accent, fontWeight: 780, fontSize: 13 }}>{displayedNode.title}</Typography>
            <Typography sx={{ mt: 0.65, color: 'rgba(255,255,255,0.66)', fontSize: { xs: 13, sm: 14 }, lineHeight: 1.65 }}>{displayedNode.summary}</Typography>
            <Stack direction="row" spacing={0.65} sx={{ mt: 1.1, flexWrap: 'wrap', gap: 0.65 }}>
              {displayedNode.facets.map((facet) => (
                <Chip key={facet} size="small" label={facet} sx={{ height: 22, color: 'rgba(255,255,255,0.72)', bgcolor: 'rgba(255,255,255,0.055)', border: '1px solid rgba(255,255,255,0.10)', '& .MuiChip-label': { px: 0.85, fontSize: 11 } }} />
              ))}
            </Stack>
            </Box>
            ) : null}
          </Box>
        </Box>
      </Box>
    </GlassCard>
  );
}

const introHeroTitle = '生息·Sense Murmur';
const finalHeroTitleLead = '不是活着，是被';
const finalHeroTitleEmphasis = '活过';
const finalHeroTitle = `${finalHeroTitleLead}${finalHeroTitleEmphasis}`;

function AnimatedHeroTitle() {
  const [text, setText] = useState(introHeroTitle);
  const [titleMode, setTitleMode] = useState<'intro' | 'final'>('intro');
  const fadingIndex = null;
  const [showCursor, setShowCursor] = useState(false);

  useEffect(() => {
    const timers: number[] = [];

    const schedule = (callback: () => void, delay: number) => {
      const timer = window.setTimeout(callback, delay);
      timers.push(timer);
    };

    const typeTitle = (index = 0, nextText = '') => {
      if (index >= finalHeroTitle.length) {
        schedule(() => setShowCursor(false), 900);
        return;
      }
      const updatedText = nextText + finalHeroTitle[index];
      setText(updatedText);
      const nextDelay = index + 1 === finalHeroTitleLead.length ? 520 : 190;
      schedule(() => typeTitle(index + 1, updatedText), nextDelay);
    };

    const deleteTitle = (length = introHeroTitle.length) => {
      if (length <= 0) {
        setText('');
        schedule(() => {
          setTitleMode('final');
          typeTitle();
        }, 180);
        return;
      }
      const deletedChar = introHeroTitle[length - 1];
      const nextDelay = deletedChar === ' ' || deletedChar === '·'
        ? 180
        : length % 4 === 0
          ? 150
          : 82;
      setText(introHeroTitle.slice(0, length - 1));
      schedule(() => deleteTitle(length - 1), nextDelay);
    };

    schedule(() => {
      setShowCursor(true);
      deleteTitle();
    }, 3000);
    return () => timers.forEach((timer) => window.clearTimeout(timer));
  }, []);

  const renderCursor = () => showCursor ? (
    <Box
      component="span"
      aria-hidden="true"
      sx={{
        display: 'inline-block',
        width: { xs: 3, md: 4 },
        height: '0.82em',
        ml: 0.55,
        transform: 'translateY(0.08em)',
        bgcolor: accent,
        animation: 'titleCursorBlink 760ms steps(2, start) infinite',
      }}
    />
  ) : (
    <Box
      component="span"
      aria-hidden="true"
      sx={{
        display: 'inline-block',
        width: { xs: 3, md: 4 },
        height: '0.82em',
        ml: 0.55,
        opacity: 0,
      }}
    />
  );

  const renderChars = (value: string, options: { size: number | { xs: number; sm?: number; md: number }; baseIndex?: number; bigChars?: boolean }) => Array.from(value).map((char, index) => {
    const absoluteIndex = (options.baseIndex ?? 0) + index;
    return (
      <Box
        key={`${titleMode}-${char}-${absoluteIndex}`}
        component="span"
        sx={{
          display: 'inline-block',
          opacity: titleMode === 'intro' && fadingIndex === absoluteIndex ? 0 : 1,
          transform: titleMode === 'intro' && fadingIndex === absoluteIndex ? 'translateY(3px)' : 'translateY(0)',
          transition: 'opacity 80ms ease, transform 80ms ease',
          whiteSpace: char === ' ' ? 'pre' : 'normal',
          fontSize: options.bigChars && char !== '。' ? { xs: 52, md: 76 } : options.size,
          lineHeight: options.bigChars && char !== '。' ? 0.92 : 1.04,
        }}
      >
        {char}
      </Box>
    );
  });

  const finalLeadText = titleMode === 'final' ? text.slice(0, finalHeroTitleLead.length) : '';
  const finalEmphasisText = titleMode === 'final' ? text.slice(finalHeroTitleLead.length) : '';
  const introSize = { xs: 38, sm: 44, md: 48 };
  const leadSize = { xs: 33, sm: 42, md: 48 };

  return (
    <Box
      component="h1"
      aria-live="polite"
      sx={{
        width: '100%',
        maxWidth: { xs: 760, lg: 900 },
        minWidth: 0,
        minHeight: { xs: 132, md: 164 },
        m: 0,
        display: 'flex',
        flexDirection: 'column',
        justifyContent: 'center',
        alignItems: 'flex-start',
        fontWeight: 850,
        letterSpacing: 0,
        color: '#F8F8FA',
        overflow: 'visible',
      }}
    >
      {titleMode === 'intro' ? (
        <Box component="span" sx={{ maxWidth: '100%', whiteSpace: 'nowrap', fontSize: introSize, lineHeight: 1.04 }}>
          {renderChars(text, { size: introSize })}
          {renderCursor()}
        </Box>
      ) : (
        <>
          <Box component="span" sx={{ maxWidth: '100%', whiteSpace: 'nowrap', fontSize: leadSize, lineHeight: 1.04 }}>
            {renderChars(finalLeadText, { size: leadSize })}
            {text.length <= finalHeroTitleLead.length ? renderCursor() : null}
          </Box>
          <Box component="span" sx={{ mt: 0.35, maxWidth: '100%', whiteSpace: 'nowrap', color: accent }}>
            {renderChars(finalEmphasisText, { size: leadSize, baseIndex: finalHeroTitleLead.length, bigChars: true })}
            {text.length > finalHeroTitleLead.length ? renderCursor() : null}
          </Box>
        </>
      )}
    </Box>
  );
}

const monoStack = "\"Roboto Mono\", \"SFMono-Regular\", ui-monospace, Menlo, Consolas, monospace";

const editorialBg = 'var(--intro-bg)';
const editorialInk = 'var(--intro-ink)';
const editorialMuted = 'var(--intro-muted)';
const editorialAmber = 'var(--intro-amber)';
const editorialAmberDeep = 'var(--intro-amber-deep)';
const editorialSurface = 'var(--intro-surface)';
const editorialCharcoal = 'var(--intro-charcoal)';
const editorialLine = 'var(--intro-line)';
const editorialStageBg = 'var(--intro-stage-bg)';
const editorialCardBg = 'var(--intro-card-bg)';
const editorialCardInk = 'var(--intro-card-ink)';
const editorialCardMuted = 'var(--intro-card-muted)';
const editorialCardLine = 'var(--intro-card-line)';
const editorialStageHalo = 'var(--intro-stage-halo)';
const editorialFocusBg = 'var(--intro-focus-bg)';
const editorialFocusInk = 'var(--intro-focus-ink)';
const editorialFocusMuted = 'var(--intro-focus-muted)';
const editorialLiftShadow = 'var(--intro-lift-shadow)';
const editorialSerif = '"Noto Serif SC", "Source Han Serif SC", Georgia, serif';

const editorialFeatures = [
  {
    key: 'group',
    label: '多角色群聊',
    title: '群聊先有来回。',
    text: '把多个 AI 角色放进同一个话题里。有人接话，有人拆台，有人旁观，也有人把话题拉回来，群聊因此有了真正的来回。',
    icon: <ForumOutlinedIcon />,
  },
  {
    key: 'profile',
    label: '角色多维设定',
    title: '角色从细节开始成形。',
    text: '外观、性格、说话方式、擅长领域、关系备注和模型设置共同作用。你先定下方向，后续每一次互动都会补上新的质感。',
    icon: <PsychologyIcon />,
  },
  {
    key: 'memory',
    label: '长期记忆和关系',
    title: '记忆把相处接下去。',
    text: '重要经历、用户偏好、共同约定和关系印象会沉淀下来。之后再开口，角色会带着背景、态度和熟悉感回来。',
    icon: <MemoryIcon />,
  },
  {
    key: 'companion',
    label: '亲密陪伴',
    title: '陪伴落在日常里。',
    text: '专属称呼、共同话语、日常问候、纪念日和低频主动关心，会跟随角色进入单聊和群聊。时间久了，关系会长出自己的纹路。',
    icon: <HubIcon />,
  },
] as const;

const editorialUtilities = [
  ['Agent 工作流', '聊天里出现明确任务时，Agent 可以继续推进。文档、代码、图表或网页小工具，都能从对话变成可保存的结果。', <ExtensionIcon />],
  ['AI 中转站', '模型、Key、额度和 API 转发集中管理。不同模型进入同一套体验，配置和调用都更清楚。', <KeyIcon />],
  ['朋友圈与活动日历', '动态、活动、纪念日和约定轻轻留痕。它们承接群聊之外的日常，让角色世界更容易回看。', <CalendarMonthIcon />],
] as const;

const editorialRuntimePillars = [
  {
    icon: <TimelineIcon />,
    label: '每轮对话判断',
    title: '谁该开口，由场面决定。',
    text: '每一轮都会综合话题、上下文、关系和用户指向，判断谁来回应、谁来补充、谁暂时旁观。',
  },
  {
    icon: <PsychologyIcon />,
    label: '角色状态组合',
    title: '设定给轮廓，互动添细部。',
    text: '性格、语气、关系备注、近期事件和模型参数会一起影响角色此刻说什么、怎么说。',
  },
  {
    icon: <MemoryIcon />,
    label: '重要记忆整理',
    title: '重要经历会被整理好。',
    text: '重要经历会被整理成下次能用的背景，把用户偏好、共同约定和关系变化带回对话。',
  },
  {
    icon: <VisibilityIcon />,
    label: '不同场景区分',
    title: '公开与私下，各有边界。',
    text: '公开群聊、用户单聊、角色私下互动和系统事件会按场景使用，信息不会粗暴挤进同一个聊天框。',
  },
] as const;

const editorialRuntimeFlow = [
  ['01', '听懂意图', '识别用户是在提问、抛话题、点名某个角色，还是需要有人主动接住情绪。'],
  ['02', '选出该说话的人', '从多个角色中挑出此刻最合适的人，也允许有人沉默、旁观或稍后再接。'],
  ['03', '调出相关经历', '调用与当前场面相关的经历、偏好、约定和关系痕迹，让回复带着上下文抵达。'],
  ['04', '说成角色自己的话', '把角色状态、语气边界和场面压力合成一条贴近当前角色的回复。'],
] as const;

const editorialRuntimeOutcomes = [
  ['发言节奏', '谁先接、谁补刀、谁旁观'],
  ['关系连续', '一次维护，会影响之后的语气'],
  ['场景边界', '群聊、单聊、角色私聊各有范围'],
] as const;

const editorialMessages = [
  { name: '阿晚', tone: '温柔但敏感', text: '我记得你上次说过，不喜欢把事情拖到很晚。今天要不要早点收一下？', x: 5, y: 22, color: '#E8A35C' },
  { name: '老李', tone: '稳重吐槽役', text: '先别急着下结论。让她把话说完，我们再拆。', x: 42, y: 8, color: '#C96F25' },
  { name: '涩涩', tone: '嘴硬但护短', text: '我没想替他说话，只是你们这次都太快开火了。', x: 30, y: 56, color: '#9F6A3D' },
];

function EditorialPill({ children, active = false }: { children: ReactNode; active?: boolean }) {
  return (
    <Box
      sx={{
        px: 1.25,
        py: 0.65,
        borderRadius: 999,
        border: '1px solid',
        borderColor: active ? 'rgba(201,111,37,0.42)' : editorialLine,
        bgcolor: active ? 'rgba(201,111,37,0.10)' : editorialCardBg,
        color: active ? editorialAmberDeep : editorialMuted,
        fontFamily: monoStack,
        fontSize: 12,
        fontWeight: 760,
        letterSpacing: 0.4,
      }}
    >
      {children}
    </Box>
  );
}

function EditorialSurface({ children, sx = {}, ...props }: { children: ReactNode; sx?: object } & Omit<ComponentProps<typeof Box>, 'children' | 'sx'>) {
  return (
    <Box
      {...props}
      sx={{
        border: `1px solid ${editorialLine}`,
        bgcolor: editorialSurface,
        borderRadius: { xs: 2.5, md: 3 },
        boxShadow: editorialLiftShadow,
        transition: `transform ${motion.durations.base}ms ${motion.crispOut}, box-shadow ${motion.durations.base}ms ${motion.crispOut}, border-color ${motion.durations.base}ms ease`,
        '&:hover': {
          transform: 'translateY(-5px)',
          borderColor: 'rgba(201,111,37,0.30)',
          boxShadow: editorialLiftShadow,
        },
        '&:active': {
          transform: 'translateY(-1px)',
          boxShadow: editorialLiftShadow,
        },
        ...sx,
      }}
    >
      {children}
    </Box>
  );
}

function EditorialRoomStage({
  activeKey,
  onActive,
  onInteractionChange,
}: {
  activeKey: (typeof editorialFeatures)[number]['key'];
  onActive: (key: (typeof editorialFeatures)[number]['key']) => void;
  onInteractionChange?: (active: boolean) => void;
}) {
  const active = editorialFeatures.find((item) => item.key === activeKey) ?? editorialFeatures[0];
  const activeIndex = editorialFeatures.findIndex((item) => item.key === activeKey);

  return (
    <EditorialSurface
      onMouseEnter={() => onInteractionChange?.(true)}
      onMouseLeave={() => onInteractionChange?.(false)}
      sx={{
        minHeight: { xs: 400, sm: 500, md: 560 },
        p: { xs: 1.4, sm: 2 },
        position: 'relative',
        overflow: 'hidden',
        bgcolor: editorialStageBg,
      }}
    >
      <Box
        aria-hidden
        sx={{
          position: 'absolute',
          inset: 0,
          backgroundImage: [
            `radial-gradient(circle at 32% 26%, ${editorialStageHalo}, transparent 180px)`,
            'radial-gradient(circle at 78% 72%, rgba(217,183,141,0.20), transparent 220px)',
          ].join(', '),
        }}
      />
      <Box sx={{ position: 'relative', zIndex: 1, height: '100%', minHeight: { xs: 372, sm: 460, md: 520 }, display: 'grid', gridTemplateRows: 'auto 1fr auto', gap: 1.2 }}>
        <Box sx={{ display: 'flex', justifyContent: 'space-between', gap: 1, alignItems: 'center' }}>
          <EditorialPill active>群聊预览</EditorialPill>
          <Box sx={{ display: 'flex', gap: 0.65 }}>
            {editorialFeatures.map((item) => (
              <Box
                key={item.key}
                component="button"
                type="button"
                aria-label={item.label}
                onMouseEnter={() => onActive(item.key)}
                onClick={() => onActive(item.key)}
                sx={{
                  width: 10,
                  height: 10,
                  borderRadius: '50%',
                  border: 'none',
                  cursor: 'pointer',
                  bgcolor: activeKey === item.key ? editorialAmber : 'rgba(33,26,22,0.18)',
                  transform: activeKey === item.key ? 'scale(1.28)' : 'scale(1)',
                  transition: 'transform 180ms ease, background-color 180ms ease',
                }}
              />
            ))}
          </Box>
        </Box>

        <Box sx={{ position: 'relative', minHeight: { xs: 214, sm: 292, md: 318 } }}>
          <Box
            aria-hidden
            sx={{
              position: 'absolute',
              left: '50%',
              top: { xs: 104, sm: 138, md: 150 },
              width: { xs: 208, sm: 286, md: 330 },
              height: { xs: 124, sm: 168, md: 188 },
              transform: 'translate(-50%, -50%)',
              opacity: 0.55,
              '&::before, &::after': {
                content: '""',
                position: 'absolute',
                inset: 0,
                borderRadius: '50%',
                border: `1px solid ${editorialCardLine}`,
              },
              '&::after': {
                inset: { xs: 34, sm: 42 },
                borderStyle: 'dashed',
                animation: 'editorialOrbit 18s linear infinite',
              },
            }}
          />
          <Box
            sx={{
              position: 'absolute',
              left: '50%',
              top: { xs: 104, sm: 140, md: 150 },
              width: { xs: 96, sm: 140, md: 154 },
              height: { xs: 96, sm: 140, md: 154 },
              transform: 'translate(-50%, -50%)',
              borderRadius: '50%',
              border: `1px solid ${editorialCardLine}`,
              animation: 'editorialBreath 5.6s ease-in-out infinite',
            }}
          />
          <Box
            sx={{
              position: 'absolute',
              left: '50%',
              top: { xs: 104, sm: 140, md: 150 },
              transform: 'translate(-50%, -50%)',
              width: { xs: 88, sm: 110 },
              p: { xs: 0.95, sm: 1.15 },
              borderRadius: 999,
              textAlign: 'center',
              bgcolor: editorialFocusBg,
              color: editorialFocusInk,
              border: `1px solid ${editorialCardLine}`,
              boxShadow: editorialLiftShadow,
              animation: `editorialRise 620ms ${motion.crispOut} 260ms both`,
              zIndex: 5,
            }}
          >
            <Typography sx={{ fontFamily: monoStack, fontSize: 10.5, fontWeight: 850, color: editorialAmber }}>TOPIC</Typography>
            <Typography sx={{ mt: 0.25, fontWeight: 850, fontSize: { xs: 11.5, sm: 12.5 }, lineHeight: 1.24 }}>今天要不要早点收一下？</Typography>
          </Box>
          {editorialMessages.map((item, index) => (
            <Box
              key={item.name}
              sx={{
                position: 'absolute',
                left: { xs: index === 0 ? '5%' : index === 1 ? '43%' : '18%', sm: `${item.x}%` },
                top: { xs: index === 0 ? '28%' : index === 1 ? '5%' : '60%', sm: `${item.y}%` },
                width: { xs: index === 1 ? 172 : 190, sm: 270 },
                p: { xs: 1.15, sm: 1.45 },
                zIndex: index === 0 ? 4 : index === 1 ? 2 : 3,
                borderRadius: 3,
                bgcolor: editorialCardBg,
                color: editorialCardInk,
                border: `1px solid ${editorialCardLine}`,
                boxShadow: editorialLiftShadow,
                animation: `editorialCardIn 720ms ${motion.crispOut} both, editorialFloat 5.8s ease-in-out infinite`,
                animationDelay: `${index * 160}ms`,
                transform: `rotate(${index === 1 ? 1.2 : index === 2 ? -1.4 : -0.8}deg)`,
                transition: `translate ${motion.durations.base}ms ${motion.crispOut}, box-shadow ${motion.durations.base}ms ${motion.crispOut}, border-color ${motion.durations.base}ms ease`,
                '&:hover': {
                  translate: '0 -6px',
                  borderColor: 'rgba(201,111,37,0.36)',
                },
              }}
            >
              <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
                <Box sx={{ width: 30, height: 30, borderRadius: '50%', bgcolor: item.color, display: 'grid', placeItems: 'center', color: '#FFF9F0', fontFamily: editorialSerif, fontWeight: 900 }}>{item.name.slice(0, 1)}</Box>
                <Box>
                  <Typography sx={{ color: editorialCardInk, fontWeight: 850, fontSize: { xs: 13, sm: 14 } }}>{item.name}</Typography>
                  <Typography sx={{ color: editorialCardMuted, fontSize: 11.5, display: { xs: 'none', sm: 'block' } }}>{item.tone}</Typography>
                </Box>
              </Box>
              <Typography sx={{ mt: { xs: 0.75, sm: 1 }, color: editorialCardInk, lineHeight: 1.58, fontSize: { xs: 12.5, sm: 13.5 } }}>{item.text}</Typography>
            </Box>
          ))}
        </Box>

        <Box sx={{ position: 'relative', minHeight: { xs: 128, sm: 142 }, overflow: 'hidden', borderRadius: 2.5, bgcolor: editorialFocusBg, color: editorialFocusInk, border: `1px solid ${editorialCardLine}` }}>
          {editorialFeatures.map((item, index) => {
            const offset = index - activeIndex;
            const selected = item.key === active.key;
            return (
              <Box
                key={item.key}
                sx={{
                  position: 'absolute',
                  inset: 0,
                  p: { xs: 1.35, sm: 1.5 },
                  opacity: selected ? 1 : 0,
                  transform: `translateX(${offset * 38}px) scale(${selected ? 1 : 0.98})`,
                  pointerEvents: selected ? 'auto' : 'none',
                  transition: `opacity 360ms ${motion.softOut}, transform 420ms ${motion.crispOut}`,
                }}
              >
                <Typography sx={{ color: editorialAmber, fontFamily: monoStack, fontSize: 12, fontWeight: 850, letterSpacing: 0.7 }}>{item.label}</Typography>
                <Typography sx={{ mt: 0.6, fontFamily: editorialSerif, fontWeight: 900, fontSize: { xs: 23, sm: 27 }, lineHeight: 1.05 }}>{item.title}</Typography>
                <Typography sx={{ mt: 0.75, color: editorialFocusMuted, lineHeight: 1.6, fontSize: { xs: 13.2, sm: 13.8 } }}>{item.text}</Typography>
              </Box>
            );
          })}
        </Box>
      </Box>
    </EditorialSurface>
  );
}

function EditorialRuntimeSection() {
  return (
    <Box sx={{ py: { xs: 4.5, md: 5.5 } }}>
      <Reveal>
        <Box
          sx={{
            position: 'relative',
            overflow: 'hidden',
            borderRadius: { xs: 2.5, md: 3 },
            bgcolor: editorialCharcoal,
            color: '#FFF4E4',
            border: `1px solid ${editorialCardLine}`,
            boxShadow: editorialLiftShadow,
          }}
        >
          <Box
            aria-hidden
            sx={{
              position: 'absolute',
              inset: 0,
              backgroundImage: [
                'linear-gradient(90deg, rgba(255,244,228,0.055) 1px, transparent 1px)',
                'linear-gradient(0deg, rgba(255,244,228,0.045) 1px, transparent 1px)',
                'radial-gradient(circle at 14% 18%, rgba(201,111,37,0.28), transparent 260px)',
              ].join(', '),
              backgroundSize: '64px 64px, 64px 64px, auto',
              opacity: 0.86,
            }}
          />
          <Box
            aria-hidden
            sx={{
              position: 'absolute',
              left: 0,
              right: 0,
              top: 0,
              height: 2,
              background: 'linear-gradient(90deg, transparent, rgba(233,163,90,0.9), transparent)',
              animation: 'editorialScanline 4.8s ease-in-out infinite',
            }}
          />

          <Box sx={{ position: 'relative', zIndex: 1, p: { xs: 1.8, sm: 2.4, md: 3 }, display: 'grid', gridTemplateColumns: { xs: '1fr', lg: '0.74fr 1.26fr' }, gap: { xs: 2.6, lg: 3.5 }, alignItems: 'start' }}>
            <Box>
              <Typography sx={{ color: '#E9A35A', fontFamily: monoStack, fontWeight: 850, fontSize: 12, letterSpacing: 1.1 }}>RUNTIME FOUNDATION</Typography>
              <Typography component="h2" sx={{ mt: 1.15, fontFamily: editorialSerif, fontWeight: 900, fontSize: { xs: 30, md: 42 }, lineHeight: 1.05, letterSpacing: 0 }}>
                每一句像自然发生，背后都经过选择。
              </Typography>
              <Typography sx={{ mt: 1.35, color: 'rgba(255,244,228,0.70)', lineHeight: 1.74, fontSize: { xs: 14.5, md: 15.5 } }}>
                多角色群聊要处理的远不止轮流发言。系统会读懂意图、选择角色、带入记忆、维持关系一致性，再把这一切藏进一句自然的话里。
              </Typography>
              <Box sx={{ mt: 1.9, display: 'grid', gridTemplateColumns: { xs: 'repeat(2, minmax(0, 1fr))', sm: 'repeat(4, minmax(0, 1fr))', lg: 'repeat(2, minmax(0, 1fr))' }, gap: 0.85 }}>
                {[
                  ['发言选择', '谁该开口'],
                  ['记忆回带', '不从零来'],
                  ['关系后效', '态度会变'],
                  ['场景分流', '边界清楚'],
                ].map(([top, bottom]) => (
                  <Box key={top} sx={{ border: '1px solid rgba(255,244,228,0.14)', borderRadius: 1.8, p: 1.05, bgcolor: 'rgba(255,244,228,0.055)', transition: `transform ${motion.durations.base}ms ${motion.crispOut}, border-color ${motion.durations.base}ms ease`, '&:hover': { transform: 'translateY(-3px)', borderColor: 'rgba(233,163,90,0.44)' }, '&:active': { transform: 'translateY(-1px)' } }}>
                    <Typography sx={{ color: '#E9A35A', fontFamily: monoStack, fontSize: 11, fontWeight: 850 }}>{top}</Typography>
                    <Typography sx={{ mt: 0.25, fontFamily: editorialSerif, fontSize: { xs: 21, md: 24 }, fontWeight: 900, lineHeight: 1 }}>{bottom}</Typography>
                  </Box>
                ))}
              </Box>
            </Box>

            <Box sx={{ display: 'grid', gap: 0.85 }}>
              {editorialRuntimeFlow.map(([step, title, text], index) => (
                <Box
                  key={step}
                  sx={{
                    position: 'relative',
                    display: 'grid',
                    gridTemplateColumns: { xs: '38px minmax(0, 1fr)', sm: '48px minmax(0, 1fr)' },
                    gap: { xs: 1, sm: 1.25 },
                    alignItems: 'start',
                    p: { xs: 1.15, sm: 1.3 },
                    borderRadius: 2,
                    border: '1px solid rgba(255,244,228,0.14)',
                    bgcolor: index === 1 ? 'rgba(233,163,90,0.12)' : 'rgba(255,244,228,0.058)',
                    overflow: 'hidden',
                    animation: `editorialFlowIn 620ms ${motion.crispOut} ${index * 80}ms both`,
                    transition: `transform ${motion.durations.base}ms ${motion.crispOut}, background-color ${motion.durations.base}ms ease, border-color ${motion.durations.base}ms ease`,
                    '&:hover': {
                      transform: 'translateX(5px)',
                      borderColor: 'rgba(233,163,90,0.45)',
                      bgcolor: 'rgba(233,163,90,0.14)',
                    },
                    '&:active': {
                      transform: 'translateX(3px)',
                    },
                    '&::after': {
                      content: '""',
                      position: 'absolute',
                      left: { xs: 21, sm: 29 },
                      top: 'calc(100% - 4px)',
                      width: 1,
                      height: index === editorialRuntimeFlow.length - 1 ? 0 : 18,
                      bgcolor: 'rgba(233,163,90,0.42)',
                    },
                  }}
                >
                  <Box sx={{ width: { xs: 34, sm: 42 }, height: { xs: 34, sm: 42 }, borderRadius: '50%', display: 'grid', placeItems: 'center', border: '1px solid rgba(233,163,90,0.42)', color: '#E9A35A', fontFamily: monoStack, fontWeight: 900, fontSize: 11.5, bgcolor: 'rgba(12,10,9,0.68)' }}>
                    {step}
                  </Box>
                  <Box>
                    <Typography sx={{ fontFamily: editorialSerif, fontWeight: 900, fontSize: { xs: 21, sm: 24 }, lineHeight: 1.05 }}>{title}</Typography>
                    <Typography sx={{ mt: 0.5, color: 'rgba(255,244,228,0.66)', lineHeight: 1.58, fontSize: 13.5 }}>{text}</Typography>
                  </Box>
                </Box>
              ))}
            </Box>
          </Box>

          <Box
            sx={{
              position: 'relative',
              zIndex: 1,
              mx: { xs: 1.8, sm: 2.4, md: 3 },
              mb: { xs: 1.8, md: 2.4 },
              p: { xs: 1.1, sm: 1.2 },
              display: 'grid',
              gridTemplateColumns: { xs: '1fr', md: 'repeat(3, minmax(0, 1fr))' },
              gap: 1,
              borderRadius: 2.6,
              border: '1px solid rgba(233,163,90,0.28)',
              bgcolor: 'rgba(233,163,90,0.10)',
              boxShadow: 'inset 0 1px 0 rgba(255,244,228,0.08)',
            }}
          >
            {editorialRuntimeOutcomes.map(([before, after], index) => (
              <Box
                key={before}
                sx={{
                  position: 'relative',
                  minHeight: { xs: 78, sm: 88 },
                  p: { xs: 1.05, sm: 1.15 },
                  borderRadius: 1.8,
                  bgcolor: index === 1 ? 'rgba(255,244,228,0.105)' : 'rgba(12,10,9,0.28)',
                  border: '1px solid rgba(255,244,228,0.12)',
                  overflow: 'hidden',
                  transition: `transform ${motion.durations.base}ms ${motion.crispOut}, border-color ${motion.durations.base}ms ease, background-color ${motion.durations.base}ms ease`,
                  '&:hover': {
                    transform: 'translateY(-4px)',
                    borderColor: 'rgba(233,163,90,0.44)',
                    bgcolor: 'rgba(255,244,228,0.12)',
                  },
                  '&:active': {
                    transform: 'translateY(-1px)',
                  },
                  '&::before': {
                    content: '""',
                    position: 'absolute',
                    left: 14,
                    top: 13,
                    width: 7,
                    height: 7,
                    borderRadius: '50%',
                    bgcolor: '#E9A35A',
                    boxShadow: '0 0 0 5px rgba(233,163,90,0.14)',
                  },
                }}
              >
                <Typography sx={{ pl: 2, color: 'rgba(255,244,228,0.52)', fontSize: 13.5, lineHeight: 1.45 }}>{before}</Typography>
                <Typography sx={{ mt: 0.65, color: '#FFF4E4', fontFamily: editorialSerif, fontWeight: 900, fontSize: { xs: 20, sm: 22 }, lineHeight: 1.1 }}>
                  {after}
                </Typography>
              </Box>
            ))}
          </Box>

          <Box sx={{ position: 'relative', zIndex: 1, px: { xs: 1.8, sm: 2.4, md: 3 }, pb: { xs: 1.8, sm: 2.4, md: 3 }, display: 'grid', gridTemplateColumns: { xs: '1fr', md: 'repeat(4, minmax(0, 1fr))' }, gap: 0.9 }}>
            {editorialRuntimePillars.map((item) => (
              <Box key={item.label} sx={{ minHeight: { xs: 'auto', md: 158 }, p: 1.35, borderRadius: 2, border: '1px solid rgba(255,244,228,0.12)', bgcolor: 'rgba(12,10,9,0.42)', transition: `transform ${motion.durations.base}ms ${motion.crispOut}, border-color ${motion.durations.base}ms ease`, '&:hover': { transform: 'translateY(-4px)', borderColor: 'rgba(233,163,90,0.38)' }, '&:active': { transform: 'translateY(-1px)' } }}>
                <Box sx={{ color: '#E9A35A', '& svg': { fontSize: 25 } }}>{item.icon}</Box>
                <Typography sx={{ mt: 1, color: 'rgba(255,244,228,0.46)', fontFamily: monoStack, fontSize: 10.5, fontWeight: 850, textTransform: 'uppercase', lineHeight: 1.2 }}>{item.label}</Typography>
                <Typography sx={{ mt: 0.65, fontFamily: editorialSerif, fontSize: 20, fontWeight: 900, lineHeight: 1.1 }}>{item.title}</Typography>
                <Typography sx={{ mt: 0.65, color: 'rgba(255,244,228,0.62)', lineHeight: 1.56, fontSize: 13 }}>{item.text}</Typography>
              </Box>
            ))}
          </Box>
        </Box>
      </Reveal>
    </Box>
  );
}

function EditorialIntroPage() {
  const navigate = useNavigate();
  const theme = useTheme();
  const { setHideMobileBottomNav } = useLayoutHeaderActions();
  const rootRef = useRef<HTMLDivElement | null>(null);
  const [activeKey, setActiveKey] = useState<(typeof editorialFeatures)[number]['key']>('group');
  const [previewPaused, setPreviewPaused] = useState(false);

  useEffect(() => {
    setHideMobileBottomNav(true);
    return () => setHideMobileBottomNav(false);
  }, [setHideMobileBottomNav]);

  useEffect(() => {
    if (previewPaused) return undefined;
    const timer = window.setInterval(() => {
      setActiveKey((current) => {
        const index = editorialFeatures.findIndex((item) => item.key === current);
        return editorialFeatures[(index + 1) % editorialFeatures.length].key;
      });
    }, 3600);
    return () => window.clearInterval(timer);
  }, [previewPaused]);

  const handleMouseMove = (event: React.MouseEvent<HTMLDivElement>) => {
    const rect = event.currentTarget.getBoundingClientRect();
    rootRef.current?.style.setProperty('--mx', `${event.clientX - rect.left}px`);
    rootRef.current?.style.setProperty('--my', `${event.clientY - rect.top}px`);
  };

  return (
    <Box
      ref={rootRef}
      onMouseMove={handleMouseMove}
      sx={{
        '--mx': '70%',
        '--my': '18%',
        '--intro-bg': theme.palette.background.default,
        '--intro-ink': theme.palette.mode === 'dark' ? '#FFF4E4' : '#2B303A',
        '--intro-muted': theme.palette.mode === 'dark' ? 'rgba(255,244,228,0.68)' : '#687081',
        '--intro-amber': theme.palette.primary.main,
        '--intro-amber-deep': theme.palette.primary.dark,
        '--intro-surface': theme.palette.mode === 'dark' ? 'rgba(32,27,23,0.86)' : theme.palette.background.paper,
        '--intro-charcoal': theme.palette.mode === 'dark' ? '#171310' : '#27221F',
        '--intro-line': theme.palette.divider,
        '--intro-stage-bg': theme.palette.mode === 'dark' ? '#211A16' : '#FBF1E4',
        '--intro-card-bg': theme.palette.mode === 'dark' ? 'rgba(40,34,29,0.96)' : 'rgba(255,249,240,0.98)',
        '--intro-card-ink': theme.palette.mode === 'dark' ? '#FFF4E4' : '#463A31',
        '--intro-card-muted': theme.palette.mode === 'dark' ? 'rgba(255,244,228,0.58)' : theme.palette.text.secondary,
        '--intro-card-line': theme.palette.mode === 'dark' ? 'rgba(255,244,228,0.14)' : 'rgba(33,26,22,0.12)',
        '--intro-stage-halo': theme.palette.mode === 'dark' ? 'rgba(201,111,37,0.28)' : 'rgba(201,111,37,0.20)',
        '--intro-focus-bg': theme.palette.mode === 'dark' ? 'rgba(16,13,11,0.96)' : 'rgba(39,34,31,0.96)',
        '--intro-focus-ink': '#FFF4E4',
        '--intro-focus-muted': theme.palette.mode === 'dark' ? 'rgba(255,244,228,0.68)' : '#D8C6AE',
        '--intro-lift-shadow': theme.palette.mode === 'dark' ? '0 24px 70px rgba(0,0,0,0.28)' : '0 24px 70px rgba(67, 47, 31, 0.13)',
        width: '100%',
        minHeight: '100%',
        px: { xs: 2, sm: 2.5, lg: 4 },
        pt: { xs: 1.5, md: 3 },
        pb: { xs: 6, md: 8 },
        color: editorialInk,
        bgcolor: editorialBg,
        fontFamily: 'Inter, "Noto Sans SC", system-ui, sans-serif',
        position: 'relative',
        overflow: 'hidden',
        backgroundImage: [
          theme.palette.mode === 'dark'
            ? 'radial-gradient(circle at var(--mx) var(--my), rgba(201,111,37,0.22), transparent 330px)'
            : 'radial-gradient(circle at var(--mx) var(--my), rgba(201,111,37,0.18), transparent 320px)',
          theme.palette.mode === 'dark'
            ? 'linear-gradient(135deg, rgba(23,19,16,0.98), rgba(43,33,27,0.92))'
            : 'linear-gradient(135deg, rgba(255,249,240,0.92), rgba(239,220,194,0.74))',
        ].join(', '),
        ...reducedMotionDescendantSx,
        '@keyframes editorialFloat': {
          '0%, 100%': { translate: '0 0' },
          '50%': { translate: '0 -8px' },
        },
        '@keyframes editorialCardIn': {
          '0%': { opacity: 0, scale: 0.96, filter: 'saturate(0.86)' },
          '100%': { opacity: 1, scale: 1, filter: 'saturate(1)' },
        },
        '@keyframes editorialRise': {
          '0%': { opacity: 0, transform: 'translateY(18px)' },
          '100%': { opacity: 1, transform: 'translateY(0)' },
        },
        '@keyframes editorialCursor': {
          '0%, 100%': { transform: 'translate(-50%, -50%) scale(1)' },
          '50%': { transform: 'translate(-50%, -50%) scale(1.18)' },
        },
        '@keyframes editorialBreath': {
          '0%, 100%': { scale: 1, opacity: 0.48 },
          '50%': { scale: 1.08, opacity: 0.78 },
        },
        '@keyframes editorialOrbit': {
          '0%': { transform: 'rotate(0deg)' },
          '100%': { transform: 'rotate(360deg)' },
        },
        '@keyframes editorialMarquee': {
          '0%': { transform: 'translateX(0)' },
          '100%': { transform: 'translateX(-50%)' },
        },
        '@keyframes editorialScanline': {
          '0%, 100%': { transform: 'translateX(-34%)', opacity: 0.18 },
          '50%': { transform: 'translateX(34%)', opacity: 0.72 },
        },
        '@keyframes editorialFlowIn': {
          '0%': { opacity: 0, transform: 'translateX(-18px)', filter: 'saturate(0.82)' },
          '100%': { opacity: 1, transform: 'translateX(0)', filter: 'saturate(1)' },
        },
        '&::before': {
          content: '""',
          position: 'absolute',
          left: 'var(--mx)',
          top: 'var(--my)',
          width: 112,
          height: 112,
          borderRadius: '50%',
          border: '1px solid rgba(201,111,37,0.18)',
          pointerEvents: 'none',
          opacity: 0.56,
          animation: 'editorialCursor 3.2s ease-in-out infinite',
          zIndex: 0,
        },
      }}
    >
      <Box sx={{ width: 'min(1180px, 100%)', mx: 'auto', position: 'relative', zIndex: 1 }}>
        <Box sx={{ display: 'grid', gridTemplateColumns: { xs: '1fr', lg: '0.92fr 1.08fr' }, gap: { xs: 3.2, lg: 5 }, alignItems: 'center', minHeight: { lg: 'calc(100dvh - 136px)' }, pb: { xs: 4, md: 5.5 } }}>
          <Box sx={{ animation: `editorialRise 760ms ${motion.crispOut} both` }}>
            <Box sx={{ pt: { xs: 1, md: 2 } }}>
              <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 0.75, mb: 3, animation: `editorialRise 680ms ${motion.crispOut} both` }}>
                {['多角色群聊', '记忆有回声', '关系会变深', '陪伴有余温', '任务能落地'].map((item) => (
                  <EditorialPill key={item}>{item}</EditorialPill>
                ))}
              </Box>
              <Typography component="h1" sx={{ m: 0, maxWidth: 680, color: editorialInk, fontFamily: editorialSerif, fontWeight: 900, lineHeight: { xs: 1.08, md: 1.03 }, fontSize: { xs: 32, sm: 46, md: 60 }, letterSpacing: 0, animation: `editorialRise 760ms ${motion.crispOut} 80ms both` }}>
                让角色同处一场对话
                让关系自然发生
              </Typography>
              <Typography sx={{ mt: { xs: 1.55, md: 1.9 }, maxWidth: 640, color: editorialMuted, lineHeight: 1.72, fontSize: { xs: 14.5, md: 16 } , animation: `editorialRise 760ms ${motion.crispOut} 150ms both` }}>
                生息以多角色群聊为核心。你创建角色，让他们围绕同一个话题相处：有人接话，有人拆台，有人沉默；旧事会被记起，关系会改变语气，下一次开口不再从零开始。
              </Typography>
              <Stack direction="row" spacing={1.2} sx={{ mt: { xs: 2.1, md: 2.7 }, flexWrap: 'wrap', gap: 1.2, animation: `editorialRise 760ms ${motion.crispOut} 220ms both` }}>
                <Button variant="contained" startIcon={<ForumOutlinedIcon />} onClick={() => navigate('/chats/create')} sx={{ borderRadius: 999, bgcolor: editorialAmber, color: '#FFF9F0', fontWeight: 850, px: 2.4, py: 1.15, boxShadow: '0 18px 38px rgba(143,70,24,0.22)', '&:hover': { bgcolor: editorialAmberDeep, transform: 'translateY(-3px)', boxShadow: '0 24px 46px rgba(143,70,24,0.28)' }, '&:active': { transform: 'translateY(-1px)' } }}>
                  开始群聊
                </Button>
                <Button variant="outlined" startIcon={<PersonAddAlt1Icon />} onClick={() => navigate('/characters/create')} sx={{ borderRadius: 999, color: editorialInk, borderColor: 'rgba(33,26,22,0.20)', fontWeight: 850, px: 2.4, py: 1.15, '&:hover': { borderColor: editorialAmber, bgcolor: 'rgba(201,111,37,0.08)', transform: 'translateY(-3px)' }, '&:active': { transform: 'translateY(-1px)' } }}>
                  创建角色
                </Button>
              </Stack>
            </Box>
          </Box>
          <Box sx={{ animation: `editorialRise 820ms ${motion.crispOut} 120ms both` }}>
            <EditorialRoomStage activeKey={activeKey} onActive={setActiveKey} onInteractionChange={setPreviewPaused} />
          </Box>
        </Box>

        <Box sx={{ mx: { xs: -2, sm: -2.5, lg: -4 }, overflow: 'hidden', bgcolor: editorialCharcoal, color: '#FFF4E4' }}>
          <Box sx={{ display: 'flex', width: 'max-content', py: { xs: 0.95, md: 1.15 }, animation: 'editorialMarquee 26s linear infinite' }}>
            {Array.from({ length: 2 }).map((_, group) => (
              <Box key={group} sx={{ display: 'flex', alignItems: 'center' }}>
                {['多角色群聊', '角色设定', '长期记忆', '关系变化', '亲密陪伴'].map((item) => (
                  <Typography key={`${group}-${item}`} sx={{ mx: { xs: 1.8, md: 3.4 }, color: item === '多角色群聊' ? '#E9A35A' : '#FFF4E4', fontFamily: editorialSerif, fontWeight: 850, fontSize: { xs: 25, md: 36 }, whiteSpace: 'nowrap' }}>
                    {item}
                  </Typography>
                ))}
              </Box>
            ))}
          </Box>
        </Box>

        <Box sx={{ py: { xs: 4.5, md: 5.5 } }}>
          <Reveal>
            <Typography sx={{ color: editorialAmberDeep, fontFamily: monoStack, fontWeight: 850, fontSize: 12, letterSpacing: 1.1 }}>CORE EXPERIENCE</Typography>
            <Typography component="h2" sx={{ mt: 1, color: editorialInk, fontFamily: editorialSerif, fontWeight: 900, fontSize: { xs: 31, md: 48 }, lineHeight: 1.04 }}>
              先被群聊吸引，再被关系留住。
            </Typography>
          </Reveal>
          <Box sx={{ mt: 2.1, display: 'grid', gridTemplateColumns: { xs: '1fr', sm: 'repeat(2, minmax(0, 1fr))' }, gap: 1.2 }}>
            {editorialFeatures.map((item, index) => (
              <Reveal key={item.key} delay={index * 55}>
                <EditorialSurface sx={{ p: { xs: 1.75, md: 2 }, minHeight: { xs: 'auto', md: 178 }, bgcolor: editorialSurface }}>
                  <Box sx={{ color: editorialAmber, '& svg': { fontSize: 26 } }}>{item.icon}</Box>
                  <Typography sx={{ mt: 1.1, color: editorialInk, fontFamily: editorialSerif, fontWeight: 900, fontSize: { xs: 25, md: 29 }, lineHeight: 1.08 }}>{item.title}</Typography>
                  <Typography sx={{ mt: 0.85, color: editorialMuted, lineHeight: 1.66, fontSize: { xs: 14.2, md: 14.8 } }}>{item.text}</Typography>
                </EditorialSurface>
              </Reveal>
            ))}
          </Box>
        </Box>

        <EditorialRuntimeSection />

        <Box sx={{ py: { xs: 4.5, md: 5.5 }, display: 'grid', gridTemplateColumns: { xs: '1fr', lg: '0.72fr 1.28fr' }, gap: { xs: 2.2, md: 3.2 }, alignItems: 'start' }}>
          <Reveal>
            <Box>
              <EditorialPill>工具层</EditorialPill>
              <Typography component="h2" sx={{ mt: 1.6, color: editorialInk, fontFamily: editorialSerif, fontWeight: 900, fontSize: { xs: 31, md: 46 }, lineHeight: 1.04 }}>
                群聊之外，世界照样运转。
              </Typography>
              <Typography sx={{ mt: 1.3, color: editorialMuted, lineHeight: 1.7, fontSize: { xs: 14.8, md: 15.8 } }}>
                Agent、AI 中转站、朋友圈和活动日历构成群聊之外的延展层。任务结果、模型配置和日常痕迹都会回到同一个角色世界里，让陪伴能延展，也能被管理。
              </Typography>
            </Box>
          </Reveal>
          <Box sx={{ display: 'grid', gap: 1.2 }}>
            {editorialUtilities.map(([title, text, icon], index) => (
              <Reveal key={title} delay={index * 65}>
                <EditorialSurface sx={{ p: 1.45, display: 'grid', gridTemplateColumns: '36px minmax(0, 1fr)', gap: 1.2, alignItems: 'start', bgcolor: index === 0 ? '#27221F' : editorialSurface, color: index === 0 ? '#FFF4E4' : editorialInk }}>
                  <Box sx={{ color: index === 0 ? '#E9A35A' : editorialAmber, display: 'grid', '& svg': { fontSize: 25 } }}>{icon}</Box>
                  <Box>
                    <Typography sx={{ fontFamily: editorialSerif, fontWeight: 900, fontSize: { xs: 24, md: 25 }, lineHeight: 1.06 }}>{title}</Typography>
                    <Typography sx={{ mt: 0.6, color: index === 0 ? '#D8C6AE' : editorialMuted, lineHeight: 1.58, fontSize: 14.2 }}>{text}</Typography>
                  </Box>
                </EditorialSurface>
              </Reveal>
            ))}
          </Box>
        </Box>

        <Reveal>
          <Box sx={{ py: { xs: 4.5, md: 5.5 }, display: 'grid', gridTemplateColumns: { xs: '1fr', md: '1fr auto' }, gap: 2, alignItems: 'center', borderTop: `1px solid ${editorialLine}` }}>
            <Box>
              <Typography sx={{ color: editorialInk, fontFamily: editorialSerif, fontWeight: 900, fontSize: { xs: 30, md: 44 }, lineHeight: 1.04 }}>先开一个群聊。</Typography>
              <Typography sx={{ mt: 0.9, color: editorialMuted, lineHeight: 1.66 }}>创建几个角色，给他们一个话题。谁会先开口，谁会记得旧事，谁会因为你改变语气，都会在对话里显形。</Typography>
            </Box>
            <Button variant="contained" endIcon={<ArrowForwardIcon />} onClick={() => navigate('/chats/create')} sx={{ justifySelf: { xs: 'start', md: 'end' }, borderRadius: 999, bgcolor: editorialAmber, color: '#FFF9F0', fontWeight: 850, px: 2.4, py: 1.15, boxShadow: '0 18px 38px rgba(143,70,24,0.22)', '&:hover': { bgcolor: editorialAmberDeep, transform: 'translateY(-3px)', boxShadow: '0 24px 46px rgba(143,70,24,0.28)' }, '&:active': { transform: 'translateY(-1px)' } }}>
              开始群聊
            </Button>
          </Box>
        </Reveal>
      </Box>
    </Box>
  );
}

export function IntroConceptPage() {
  const navigate = useNavigate();
  const rootRef = useRef<HTMLDivElement | null>(null);

  const handleMouseMove = (event: React.MouseEvent<HTMLDivElement>) => {
    const node = rootRef.current;
    if (!node) return;
    node.style.setProperty('--mx', `${event.clientX}px`);
    node.style.setProperty('--my', `${event.clientY}px`);
  };

  return (
    <Box
      ref={rootRef}
      onMouseMove={handleMouseMove}
      sx={{
        '--mx': '50vw',
        '--my': '20vh',
        minHeight: '100dvh',
        bgcolor: bg,
        color: '#F5F5F7',
        fontFamily: 'Inter, "SF Pro Display", "Plus Jakarta Sans", -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
        position: 'relative',
        overflow: 'hidden',
        scrollBehavior: 'smooth',
        '&::before': {
          content: '""',
          position: 'fixed',
          inset: 0,
          pointerEvents: 'none',
          backgroundColor: 'transparent',
          zIndex: 0,
        },
        '&::after': {
          content: '""',
          position: 'fixed',
          inset: 0,
          pointerEvents: 'none',
          backgroundImage: 'none',
          zIndex: 0,
        },
        '@keyframes introFloat': {
          '0%, 100%': { transform: 'translateY(0)' },
          '50%': { transform: 'translateY(-8px)' },
        },
        '@keyframes introOrbit': {
          '0%': { transform: 'rotate(0deg)' },
          '100%': { transform: 'rotate(360deg)' },
        },
        '@keyframes introPulse': {
          '0%, 100%': { transform: 'translateY(0)', opacity: 0.74 },
          '50%': { transform: 'translateY(-4px)', opacity: 1 },
        },
        '@keyframes heroOrbBreath': {
          '0%, 100%': {
            transform: 'scale(1)',
            borderColor: 'rgba(229,192,123,0.42)',
            boxShadow: '0 0 52px rgba(229,192,123,0.08), 0 0 80px rgba(0,0,0,0.16)',
          },
          '50%': {
            transform: 'scale(1.035)',
            borderColor: 'rgba(229,192,123,0.78)',
            boxShadow: '0 0 104px rgba(229,192,123,0.22), 0 0 128px rgba(0,0,0,0.22)',
          },
        },
        '@keyframes heroOrbWave': {
          '0%': { opacity: 0, transform: 'scale(0.58)' },
          '16%': { opacity: 0.86 },
          '100%': { opacity: 0, transform: 'scale(1.56)' },
        },
        '@keyframes heroOrbSpin': {
          '0%': { transform: 'rotate(0deg) scale(0.98)', opacity: 0.48 },
          '50%': { transform: 'rotate(180deg) scale(1.04)', opacity: 0.82 },
          '100%': { transform: 'rotate(360deg) scale(0.98)', opacity: 0.48 },
        },
        '@keyframes personaBreath': {
          '0%, 100%': { scale: 1, opacity: 0.82 },
          '50%': { scale: 1.08, opacity: 1 },
        },
        '@keyframes systemBreath': {
          '0%, 100%': { scale: 1, opacity: 0.78 },
          '50%': { scale: 1.06, opacity: 1 },
        },
        '@keyframes systemSlide': {
          '0%, 100%': { transform: 'translateX(0)', opacity: 0.72 },
          '50%': { transform: 'translateX(6px)', opacity: 1 },
        },
        '@keyframes systemBar': {
          '0%, 100%': { transform: 'scaleX(0.86)', transformOrigin: 'left center', opacity: 0.72 },
          '50%': { transform: 'scaleX(1)', opacity: 1 },
        },
        '@keyframes systemFloatSmall': {
          '0%, 100%': { transform: 'translateY(0)' },
          '50%': { transform: 'translateY(-5px)' },
        },
        '@keyframes ripplePulse': {
          '0%': { boxShadow: '0 0 0 0 rgba(229,192,123,0.30)' },
          '100%': { boxShadow: '0 0 0 18px rgba(229,192,123,0)' },
        },
        '@keyframes titleCursorBlink': {
          '0%, 45%': { opacity: 1 },
          '46%, 100%': { opacity: 0 },
        },
        '@keyframes metricRipple': {
          '0%': { opacity: 0.58, transform: 'scale(0.72)' },
          '100%': { opacity: 0, transform: 'scale(1.38)' },
        },
      }}
    >
      <Box sx={{ position: 'relative', zIndex: 1, width: 'min(1180px, calc(100% - 32px))', mx: 'auto', py: { xs: 2, md: 2.25 } }}>
        <Box sx={{ position: 'sticky', top: 12, zIndex: 5, mb: { xs: 3, md: 2.5 }, display: { xs: 'none', md: 'flex' }, alignItems: 'center', justifyContent: 'space-between', border: `1px solid ${border}`, borderRadius: 2, px: 2, py: 1, bgcolor: 'rgba(10,10,15,0.58)', backdropFilter: 'blur(18px)' }}>
          <Typography sx={{ fontWeight: 760, letterSpacing: 0, color: '#fff' }}>Sense Murmur</Typography>
          <Stack direction="row" spacing={0.5}>
            {navItems.map(([id, label]) => (
              <Button key={id} size="small" onClick={() => scrollToSection(id)} sx={{ color: 'rgba(255,255,255,0.62)', borderRadius: 1.5, px: 1.25, '&:hover': { color: '#0A0A0F', bgcolor: accent } }}>
                {label}
              </Button>
            ))}
          </Stack>
        </Box>

        <Box id="world" sx={{ minHeight: { xs: 'auto', lg: 'min(700px, calc(100dvh - 112px))' }, display: 'grid', gridTemplateColumns: { xs: 'minmax(0, 1fr)', lg: 'minmax(0, 1.03fr) minmax(0, 0.97fr)' }, gap: { xs: 4, lg: 6 }, alignItems: { xs: 'center', lg: 'start' }, pt: { xs: 1, md: 0.5 }, pb: { xs: 5, md: 7 } }}>
          <Reveal>
            <Box sx={{ minWidth: 0 }}>
              <Stack direction="row" spacing={1} sx={{ flexWrap: 'wrap', gap: 1, mb: { xs: 3, md: 3.5, lg: 4 } }}>
                {['AI 多角色互动房间', '长期记忆与关系连续性', '群聊 / 单聊 / 角色私聊'].map((label) => (
                  <Chip
                    key={label}
                    label={label}
                    variant="outlined"
                    sx={{
                      color: 'rgba(255,255,255,0.82)',
                      borderColor: 'rgba(255,255,255,0.18)',
                      bgcolor: 'rgba(255,255,255,0.05)',
                      height: { xs: 30, md: 32 },
                      px: { xs: 0.35, md: 0.55 },
                      '& .MuiChip-label': {
                        px: { xs: 0.75, md: 1 },
                        fontSize: { xs: 12.5, md: 13.5 },
                        fontWeight: 560,
                        lineHeight: 1.25,
                        letterSpacing: 0.2,
                      },
                    }}
                  />
                ))}
              </Stack>
              <AnimatedHeroTitle />
              <Typography sx={{ mt: { xs: 2, md: 2.25 }, maxWidth: 720, color: 'rgba(255,255,255,0.62)', lineHeight: 1.85, fontSize: { xs: 16, md: 18 } }}>
                “生息”不是把 AI 放进聊天框，而是给角色一段可以延续的时间。创建角色、多角色群聊、参与故事创作——旧事、关系、情绪和余波，都会在下一次对话里回来。
              </Typography>
              <Stack direction="row" spacing={1.5} sx={{ mt: { xs: 4, lg: 6 }, flexWrap: 'wrap', alignItems: 'center' }}>
                <Button
                  variant="contained"
                  size="large"
                  endIcon={<ArrowForwardIcon />}
                  onClick={() => navigate('/characters/create')}
                  sx={{ width: 'fit-content', minWidth: 0, borderRadius: 2, px: 3, py: 1.25, bgcolor: accent, color: '#0A0A0F', fontWeight: 760, boxShadow: 'none', '&:hover': { bgcolor: '#F5F5F7', color: '#0A0A0F', animation: 'ripplePulse 520ms ease-out' } }}
                >
                  创建角色
                </Button>
                <Button
                  variant="outlined"
                  size="large"
                  onClick={() => navigate('/chats/create')}
                  sx={{ width: 'fit-content', minWidth: 0, borderRadius: 2, px: 3, py: 1.25, borderColor: 'rgba(255,255,255,0.22)', color: '#F5F5F7', '&:hover': { borderColor: accent, bgcolor: accent, color: '#0A0A0F' } }}
                >
                  开始群聊
                </Button>
              </Stack>
            </Box>
          </Reveal>
          <Reveal delay={120}>
            <Box sx={{ minWidth: 0 }}>
              <HeroVisual />
            </Box>
          </Reveal>
        </Box>

        <MockGroupChatSnapshot />

        <MemoryContinuitySection />

        <EngineSection />

        <RuntimeSystemSection />

        <Box id="craft" sx={{ py: { xs: 5, md: 7 } }}>
          <Reveal>
            <GlassCard sx={{ p: { xs: 2.5, md: 3.25 }, overflow: 'hidden', position: 'relative' }}>
              <Box sx={{ position: 'absolute', right: -120, top: -140, width: 360, height: 360, borderRadius: '50%', border: '1px solid rgba(229,192,123,0.12)' }} />
              <Box sx={{ position: 'relative', display: 'grid', gridTemplateColumns: { xs: '1fr', md: '0.78fr 1.22fr' }, gap: { xs: 4, md: 6 } }}>
                <Box>
                  <TimelineIcon sx={{ color: accent, fontSize: 34, mb: 2 }} />
                  <Typography sx={{ fontWeight: 840, lineHeight: { xs: 1.16, md: 1.12 }, fontSize: { xs: 32, md: 48 }, color: '#F8F8FA' }}>
                    所有复杂度，都在<Box component="span" sx={{ color: accent }}>守护</Box>这种延续。
                  </Typography>
                  <Typography sx={{ mt: 2, color: 'rgba(255,255,255,0.58)', lineHeight: 1.85 }}>
                    角色不该每次都从零开始。私聊、关系账本、记忆、事件和房间规则，最后都指向同一件事：让你创建的角色能被带进新的场景，并仍然知道“我是我”。
                  </Typography>
                </Box>
                <CraftContinuityPanel />
              </Box>
            </GlassCard>
          </Reveal>
        </Box>

        <Reveal>
          <Box sx={{ py: { xs: 6, md: 8 }, textAlign: 'center' }}>
            <PsychologyIcon sx={{ color: accent, fontSize: 34, mb: 2 }} />
            <Typography sx={{ mx: 'auto', maxWidth: 880, fontWeight: 850, lineHeight: { xs: 1.15, md: 1.1 }, fontSize: { xs: 34, md: 56 }, color: '#F8F8FA' }}>
              我们不是在制造更聪明的回复者，而是在尝试让一个虚构角色拥有<Box component="span" sx={{ color: accent }}>来处、牵挂和未完成</Box>。
            </Typography>
            <Typography sx={{ mx: 'auto', mt: 2.5, maxWidth: 760, color: 'rgba(255,255,255,0.58)', lineHeight: 1.85 }}>
              人除了物质之外，还由记忆、关系、选择、羞耻、偏爱、承诺和未完成组成。Sense Murmur 想做的，是让你创建的角色也能在群聊、单聊和未来的房间里，慢慢长出形状。
            </Typography>
            <Button
              variant="contained"
              size="large"
              endIcon={<ArrowForwardIcon />}
              onClick={() => navigate('/')}
              sx={{ mt: 4, borderRadius: 2, px: 3.5, py: 1.35, bgcolor: '#F5F5F7', color: '#0A0A0F', fontWeight: 800, boxShadow: 'none', '&:hover': { bgcolor: accent, animation: 'ripplePulse 520ms ease-out' } }}
            >
              进入 Sense Murmur
            </Button>
          </Box>
        </Reveal>
      </Box>
    </Box>
  );
}

export default IntroConceptPage;
