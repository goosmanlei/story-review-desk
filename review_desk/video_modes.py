"""Channel-specific, offline contract checks; never a provider availability test.

The observation is deliberately separate from plans and immutable real calls.
Missing channel/mode evidence stays unknown, including otherwise valid inputs.
"""
import json
from pathlib import Path

CAPABILITIES = json.loads(Path(__file__).with_name('video_capabilities.json').read_text())
MODE_NAMES = {'reference': '普通参考生成', 'first_frame': '固定首帧',
              'first_last_frame': '固定首尾帧', 'edit': '视频编辑', 'extend': '视频延长'}
ROLE_NAMES = {'reference_image': '普通图像参考', 'first_frame': '固定首帧',
              'last_frame': '固定尾帧', 'reference_audio': '音频参考',
              'reference_video': '普通视频参考', 'source_video': '待编辑或延长的视频'}
MODE_KEYS = {'reference': 'reference_generation', 'edit': 'video_edit',
             'extend': 'video_extend', 'first_last_frame': 'first_last_frame'}


def applies(model):
    return model in CAPABILITIES['models']


def validate_shape(execution, inputs):
    """Allow unsupported *plans* to be reviewed; reject malformed declarations."""
    if execution is not None:
        if not isinstance(execution, dict) or not all(isinstance(execution.get(k), str) and execution[k].strip()
                                                    for k in ('channel', 'mode', 'start_constraint')):
            raise ValueError('execution requires channel, mode and start_constraint')
        if execution['start_constraint'] not in ('reference', 'fixed', 'none'):
            raise ValueError('unsupported start constraint')
    for item in inputs:
        if 'role' in item and (not isinstance(item['role'], str) or not item['role'].strip()):
            raise ValueError('input role must be a nonempty string')


def check(model, parameters, execution, inputs):
    """Inputs contain media_type and role, in the actual active upload order."""
    issues, unknown = [], []
    result = {'status': 'unknown', 'verified': False, 'issues': issues, 'unknowns': unknown,
              'scope': CAPABILITIES['scope'], 'channel': (execution or {}).get('channel'),
              'mode': (execution or {}).get('mode'), 'mode_label': MODE_NAMES.get((execution or {}).get('mode'), '待判断'),
              'start_constraint': (execution or {}).get('start_constraint'),
              'evidence': {'source': CAPABILITIES['source'], 'cli_version': CAPABILITIES['version']}}
    profile = CAPABILITIES['models'].get(model)
    if not profile or not execution or execution.get('channel') != CAPABILITIES['channel']:
        unknown.append('尚无此模型、渠道及明确生成模式的组合依据')
        return result
    result['evidence']['observed_at'] = profile['observed_at']
    mode = execution['mode']
    kinds = [v['media_type'] for v in inputs]
    supported = {'duration', 'resolution', 'aspect_ratio', 'ratio', 'task_type', 'generate_type', 'seed', 'source'}
    if parameters.keys() - supported:
        unknown.append('这些参数尚无本准备路径的组合依据：' + '、'.join(sorted(parameters.keys() - supported)))
    if model == 'seedance2.0_fast_vision' and 'audio' in kinds and not ({'image', 'video'} & set(kinds)):
        unknown.append('2.0 Fast 只有音频参考而无视觉输入的组合尚未核实')
    ratio = parameters.get('aspect_ratio', parameters.get('ratio'))
    if 'ratio' in parameters and 'aspect_ratio' in parameters and parameters['ratio'] != parameters['aspect_ratio']:
        issues.append('ratio 与 aspect_ratio 不一致')
    if ratio not in profile['ratio']['options']:
        issues.append('未指定有效的渠道画幅参数')
    task = parameters.get('task_type')
    generate = parameters.get('generate_type')
    if generate is not None and (type(generate) is not int or generate not in (0, 1)):
        unknown.append('此 generate_type 尚无渠道契约依据')
    if mode not in MODE_NAMES:
        unknown.append('生成模式尚未核实：' + mode)
    if mode == 'first_frame':
        unknown.append('此 CLI 尚无已核实的 Seedance 单首帧角色入口；不能用普通参考代替固定起点')
    if mode == 'reference':
        if task != 'reference' or generate not in (None, 0):
            issues.append('普通参考须显式 task_type=reference，不能同时设置首尾帧 generate_type=1')
        if execution['start_constraint'] == 'fixed':
            issues.append('普通参考生成不能兑现固定起点约束')
    elif mode == 'first_last_frame':
        if generate != 1 or type(generate) is not int or task not in (None, 'auto'):
            issues.append('固定首尾帧须 generate_type=1，不能同时指定其他 task_type')
        if execution['start_constraint'] != 'fixed':
            issues.append('首尾帧模式应声明固定起点')
        if kinds.count('image') != CAPABILITIES['cli_first_last_image_count']:
            issues.append('此 CLI 的 Seedance 首尾帧入口须按首帧、尾帧顺序提供两张图')
    elif mode in ('edit', 'extend'):
        if task != mode or generate not in (None, 0):
            issues.append('编辑或延长的 task_type 与模式不一致')
        if kinds.count('video') != 1:
            unknown.append('当前准备路径只核实一条明确源视频；多源编辑或延长仍待判断')

    # 2.0 exposes capability flags, not the 2.5 mode combinations. Do not
    # inherit 2.5's adaptive-only or no-audio restriction from those flags.
    modes = {v['key']: v for v in profile.get('creation_modes', [])}
    configured = modes.get(MODE_KEYS.get(mode))
    if configured:
        if not configured.get('enabled'):
            issues.append('渠道配置未启用此模式')
        if ratio not in configured['ratio']['options']:
            issues.append('此模式仅支持画幅：' + '、'.join(configured['ratio']['options']))
        policy = configured.get('validation_policy', {})
        forbidden = set(policy.get('forbidden_input_types', [])) & set(kinds)
        if forbidden:
            issues.append('此模式禁止独立输入：' + '、'.join(sorted(forbidden)))
        if kinds.count('video') < policy.get('required_video_count', 0):
            issues.append('此模式缺少必要源视频')
        if configured.get('duration_policy') == 'smart_disabled' and 'duration' in parameters:
            issues.append('此编辑模式时长随输入处理，不支持指定生成时长')
    elif mode != 'reference':
        unknown.append('此模型未返回该模式的完整组合规则，不能据能力标记判定可执行')
    if mode == 'first_last_frame' and 'video' in kinds:
        unknown.append('首尾帧同时输入视频的渠道职责尚未核实')

    image_index = 0
    for item in inputs:
        kind, role = item['media_type'], item.get('role')
        if not role:
            unknown.append('尚未声明 ' + kind + ' 输入的渠道角色')
            continue
        expected = {'image': 'reference_image', 'audio': 'reference_audio', 'video': 'reference_video'}.get(kind)
        if mode == 'first_last_frame' and kind == 'image':
            expected = 'first_frame' if image_index == 0 else 'last_frame'
            image_index += 1
        elif mode == 'first_frame' and kind == 'image':
            expected = 'first_frame'
        elif mode in ('edit', 'extend') and kind == 'video':
            expected = 'source_video'
        if role != expected:
            issues.append('输入角色与媒体及模式不一致：' + str(role))
    result['issues'] = list(dict.fromkeys(issues))
    result['unknowns'] = list(dict.fromkeys(unknown))
    result['status'] = 'incompatible' if issues else 'unknown' if unknown else 'compatible'
    result['verified'] = result['status'] == 'compatible'
    return result
