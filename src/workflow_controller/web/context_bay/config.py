# Copyright (c) 2026 Workflow Controller Contributors
#
# Licensed under the MIT License (the "License");
# you may not use this file except in compliance with the License.
# You may obtain a copy of the License at
#
#     http://opensource.org/licenses/MIT
#
# Unless required by applicable law or agreed to in writing, software
# distributed under the License is distributed on an "AS IS" BASIS,
# WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
# See the License for the specific language governing permissions and
# limitations under the License.

"""CANN 上传领域配置：领域自有配置段的模型与合并视图。

全局 workflow-controller-config.yaml 与项目 workflow-controller.yaml 各有独立 context_bay 段；段的键
集合、类型归一与项目级覆盖只在本模块定义，内核对段内容不透明。
"""

from __future__ import annotations

from pathlib import Path
from typing import TYPE_CHECKING, Any

import yaml
from pydantic import BaseModel, ConfigDict, ValidationError, field_validator

if TYPE_CHECKING:
    from workflow_controller.api.core_api import CoreAPI

#: 领域段名（全局与项目 yaml 同名段）
SECTION_NAME = "context_bay"


class ContextBayConfig(BaseModel):
    """上传配置模型：类型归一与校验的全仓唯一发生地。"""

    # 闭合模型：未知键拒绝，坏值在写入边界暴露
    model_config = ConfigDict(extra="forbid")

    repo_url: str = ""
    snapshot_paths: list[str] = []

    @field_validator("repo_url", mode="before")
    @classmethod
    def repo_url_normalized(cls, value: Any) -> Any:
        """null 归空串、字符串去首尾空白。"""
        if value is None:
            return ""
        return value.strip() if isinstance(value, str) else value

    @field_validator("snapshot_paths", mode="before")
    @classmethod
    def snapshot_paths_normalized(cls, value: Any) -> Any:
        """null 归空列表、单值字符串按单元素列表。"""
        if value is None:
            return []
        return [value] if isinstance(value, str) else value


def _valid_section_values(section: dict[str, Any]) -> dict[str, Any]:
    """段值逐键过模型校验并归一：手改 yaml 的坏值/未知键按未配置跳过。"""
    out: dict[str, Any] = {}
    for key in ContextBayConfig.model_fields:
        value = section.get(key)
        if not value:
            continue
        try:
            out[key] = ContextBayConfig.model_validate({key: value}).model_dump()[key]
        except ValidationError:
            continue
    return out


def _project_section(project_dir: str) -> dict[str, Any]:
    """读项目 yaml 的 context_bay 段；无文件/坏文件返回空。"""
    try:
        data = (
            yaml.safe_load(
                (Path(project_dir) / "workflow-controller.yaml").read_text(encoding="utf-8")
            )
            or {}
        )
    except Exception:
        return {}
    if not isinstance(data, dict):
        return {}
    section = data.get(SECTION_NAME)
    return _valid_section_values(section if isinstance(section, dict) else {})


def load_global_upload_config(core_api: CoreAPI) -> ContextBayConfig:
    """全局段视图：设置页读写共用，项目覆盖不并入（避免保存时烘焙进全局）。"""
    return ContextBayConfig.model_validate(
        _valid_section_values(core_api.config.get_section(SECTION_NAME) or {})
    )


def load_upload_config(core_api: CoreAPI) -> ContextBayConfig:
    """上传配置合并视图：全局 context_bay 段 + 项目 yaml 逐键覆盖（留空视为未配置）。"""
    merged = load_global_upload_config(core_api).model_dump()
    merged.update(_project_section(core_api.config.project_dir))
    return ContextBayConfig.model_validate(merged)
