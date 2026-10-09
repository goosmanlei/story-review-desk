"""Ordered reference labels and checked model-specific prompt conventions.

Does not rewrite prompts. Historical CALL payloads never pass through this code.
"""
import re

LABELS = {'image':'图片', 'audio':'音频', 'video':'视频'}


def check_declared(model, prompt, media_types):
    """Plan shape can be checked before media are selected; no readiness claim."""
    issues = []
    if model in ('seedance2.0_fast_vision','Seedance_2.5'):
        fast = model == 'seedance2.0_fast_vision'
        if len(prompt) > (5000 if fast else 15000):issues.append('Prompt 长度超过模型限制')
        limits = {'image':9 if fast else 30,'audio':3 if fast else 10,'video':3 if fast else 10}
        if any(kind not in limits for kind in media_types):issues.append('模型参考类型不支持')
        for kind, limit in limits.items():
            if media_types.count(kind) > limit:issues.append(kind+' reference count exceeds model limit')
        if not fast and len(media_types)>50:issues.append('total reference count exceeds model limit')
        counts = {}; labels = set()
        for kind in media_types:
            if kind not in LABELS:continue
            counts[kind] = counts.get(kind,0)+1
            labels.add(LABELS[kind]+str(counts[kind]))
        mentions = set(re.findall(r'@(图片\d+|音频\d+|视频\d+)',prompt))
        if mentions-labels:issues.append('提示词指代了未提交的参考输入')
        if labels-mentions:issues.append('提示词缺少真实输入指代：'+','.join(sorted(labels-mentions)))
    return issues


def label_inputs(inputs):
    counts={};result=[]
    for index,value in enumerate(inputs):
        kind=value['component']['mime'].split('/')[0]
        if kind not in LABELS:
            raise ValueError('generation reference must be an image, audio or video')
        counts[kind]=counts.get(kind,0)+1
        result.append({**value,'input_index':index+1,'label':LABELS[kind]+str(counts[kind])})
    return result


def check(model, prompt, inputs, *, parameters=None, execution=None):
    labels=[v['label'] for v in inputs];issues=check_declared(model,prompt,[v['component']['mime'].split('/')[0] for v in inputs])
    from . import video_modes
    mode = None
    if video_modes.applies(model) or execution is not None:
        mode = video_modes.check(model, parameters or {}, execution, [
            {'media_type': v['component']['mime'].split('/')[0], 'role': v.get('role')} for v in inputs])
        try:check_parameters(model, parameters or {})
        except ValueError as exc:issues.append(str(exc))
        issues.extend(mode['issues'])
    if not inputs:
        return {'model':model,'convention':'text only','verified':not issues and (mode is None or mode['verified']),
                'issues':issues, **({'mode_check':mode} if mode else {})}
    if model in ('gpt-image-2-5-sunburst','gpt-image-2'):
        convention='OpenArt visualReferences ordered array; describe 图片1、图片2 in natural language'
        if any(not v['component']['mime'].startswith('image/') for v in inputs) or len(inputs)>16:
            issues.append('该 OpenArt 图像模式仅接受最多 16 张图片参考')
        for label in labels:
            if not re.search(re.escape(label)+r'(?!\d)',prompt):issues.append('提示词未说明参考 '+label+' 的用途')
    elif model in ('seed-audio-1.0','Seedance 2.0','seedance-2.0','seedance2.0_fast_vision','Seedance_2.5'):
        convention='@图片N / @音频N / @视频N in per-type upload order'
        if model=='seed-audio-1.0' and (any(not v['component']['mime'].startswith('audio/') for v in inputs) or len(inputs)>3):
            issues.append('当前 Seed Audio 工具契约只支持最多 3 条音频参考')
        if model in ('seedance2.0_fast_vision','Seedance_2.5'):
            fast=model=='seedance2.0_fast_vision'
            limits={'image':9 if fast else 30,'audio':3 if fast else 10,'video':3 if fast else 10}
            for kind,limit in limits.items():
                parts=[v for v in inputs if v['component']['mime'].startswith(kind+'/')]
                if len(parts)>limit:issues.append(kind+' reference count exceeds model limit')
                if kind!='image':
                    durations=[v.get('range',{}).get('end_seconds',v['component'].get('duration_seconds',0))-v.get('range',{}).get('start_seconds',0) for v in parts]
                    maximum=(15.5 if fast else 30.2) if kind=='video' else (15 if fast else 30)
                    if any(not 2<=d<=maximum for d in durations):issues.append(kind+' reference duration outside model limit')
                    if sum(durations)>(15.5 if kind=='video' and fast else 15.2 if fast else 30.2):issues.append(kind+' total reference duration exceeds model limit')
        for label in labels:
            if not re.search(r'@'+re.escape(label)+r'(?!\d)',prompt):issues.append('提示词缺少真实输入指代 @'+label)
        mentions=set(re.findall(r'@(图片\d+|音频\d+|视频\d+)',prompt))
        if mentions-set(labels):issues.append('提示词指代了未提交的参考输入')
    else:
        return {'model':model,'convention':'UNKNOWN; verify the execution platform contract','verified':False,'issues':issues,
                **({'mode_check':mode} if mode else {})}
    return {'model':model,'convention':convention,'verified':not issues and (mode is None or mode['verified']),
            'issues':list(dict.fromkeys(issues)), **({'mode_check':mode} if mode else {})}


def check_parameters(model, parameters):
    if model not in ('seedance2.0_fast_vision','Seedance_2.5'):return
    duration=parameters.get('duration')
    editing = model == 'Seedance_2.5' and parameters.get('task_type') == 'edit' and duration is None
    if not editing and (type(duration) is not int or not 4<=duration<=(15 if model=='seedance2.0_fast_vision' else 30)):
        raise ValueError('Seedance duration outside verified single-call limits')
    allowed=('480p','720p') if model=='seedance2.0_fast_vision' else ('480p','720p','1080p')
    if parameters.get('resolution') not in allowed:raise ValueError('unsupported Seedance resolution')


def planned_contract(plan, declarations):
    """Check active, declared roles before selection, without claiming file readiness."""
    from . import video_modes
    issues = check_declared(plan['model'], plan['prompt'], [v['media_type'] for v in declarations])
    try:check_parameters(plan['model'], plan['parameters'])
    except ValueError as exc:issues.append(str(exc))
    result = {'scope':'仅检查计划参数、附件编号和声明角色；原件、采纳和实际效果另验',
              'issues':issues, 'verified':not issues}
    if video_modes.applies(plan['model']) or plan.get('execution') is not None:
        mode = video_modes.check(plan['model'], plan['parameters'], plan.get('execution'), declarations)
        result['mode_check'] = mode
        issues.extend(mode['issues'])
        result['verified'] = not issues and mode['verified']
    return result
