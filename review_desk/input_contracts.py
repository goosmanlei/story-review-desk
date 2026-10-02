"""Ordered reference labels and checked model-specific prompt conventions.

Does not rewrite prompts. Historical CALL payloads never pass through this code.
"""
import re

LABELS = {'image':'图片', 'audio':'音频', 'video':'视频'}


def label_inputs(inputs):
    counts={};result=[]
    for index,value in enumerate(inputs):
        kind=value['component']['mime'].split('/')[0]
        if kind not in LABELS:
            raise ValueError('generation reference must be an image, audio or video')
        counts[kind]=counts.get(kind,0)+1
        result.append({**value,'input_index':index+1,'label':LABELS[kind]+str(counts[kind])})
    return result


def check(model, prompt, inputs):
    labels=[v['label'] for v in inputs];issues=[]
    if not inputs:return {'model':model,'convention':'text only','verified':True,'issues':[]}
    if model in ('gpt-image-2-5-sunburst','gpt-image-2'):
        convention='OpenArt visualReferences ordered array; describe 图片1、图片2 in natural language'
        if any(not v['component']['mime'].startswith('image/') for v in inputs) or len(inputs)>16:
            issues.append('该 OpenArt 图像模式仅接受最多 16 张图片参考')
        for label in labels:
            if not re.search(re.escape(label)+r'(?!\d)',prompt):issues.append('提示词未说明参考 '+label+' 的用途')
    elif model in ('seed-audio-1.0','Seedance 2.0','seedance-2.0'):
        convention='@图片N / @音频N / @视频N in per-type upload order'
        if model=='seed-audio-1.0' and (any(not v['component']['mime'].startswith('audio/') for v in inputs) or len(inputs)>3):
            issues.append('当前 Seed Audio 工具契约只支持最多 3 条音频参考')
        for label in labels:
            if not re.search(r'@'+re.escape(label)+r'(?!\d)',prompt):issues.append('提示词缺少真实输入指代 @'+label)
        mentions=set(re.findall(r'@(图片\d+|音频\d+|视频\d+)',prompt))
        if mentions-set(labels):issues.append('提示词指代了未提交的参考输入')
    else:
        return {'model':model,'convention':'UNKNOWN; verify the execution platform contract','verified':False,'issues':[]}
    return {'model':model,'convention':convention,'verified':not issues,'issues':issues}
