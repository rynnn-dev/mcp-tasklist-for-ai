import { TasklistError, type TaskRecord } from "../types.ts";

export interface DependencyEdge {
  task_id: string;
  depends_on_task_id: string;
}

/**
 * Validates that adding new dependency edges does not introduce a cycle.
 * Uses 3-color DFS (0 = unvisited, 1 = visiting, 2 = visited) and returns
 * an explicit cycle path if one is found.
 */
export function validateNoCycles(
  allTaskIds: ReadonlySet<string>,
  edges: readonly DependencyEdge[]
): void {
  const adjacency = new Map<string, string[]>();
  for (const id of allTaskIds) {
    adjacency.set(id, []);
  }

  for (const edge of edges) {
    if (edge.task_id === edge.depends_on_task_id) {
      throw new TasklistError(
        "CYCLE_DETECTED",
        `Circular dependency detected: ${edge.task_id} -> ${edge.task_id}`,
        { cycle: [edge.task_id, edge.task_id] }
      );
    }
    const list = adjacency.get(edge.task_id);
    if (list) {
      list.push(edge.depends_on_task_id);
    } else {
      adjacency.set(edge.task_id, [edge.depends_on_task_id]);
    }
  }

  const state = new Map<string, 0 | 1 | 2>();
  const stack: string[] = [];

  const dfs = (node: string): void => {
    state.set(node, 1);
    stack.push(node);

    const deps = adjacency.get(node) ?? [];
    for (const dep of deps) {
      const depState = state.get(dep) ?? 0;
      if (depState === 1) {
        const cycleStartIdx = stack.indexOf(dep);
        const cyclePath = [...stack.slice(cycleStartIdx), dep];
        throw new TasklistError(
          "CYCLE_DETECTED",
          `Circular dependency detected: ${cyclePath.join(" -> ")}`,
          { cycle: cyclePath }
        );
      }
      if (depState === 0) {
        dfs(dep);
      }
    }

    stack.pop();
    state.set(node, 2);
  };

  for (const id of adjacency.keys()) {
    if ((state.get(id) ?? 0) === 0) {
      dfs(id);
    }
  }
}

/**
 * Groups tasks into parallel topological execution waves using Kahn's algorithm.
 * Wave 0 has tasks with no dependencies; Wave N contains tasks whose prerequisites
 * are all in Waves < N.
 */
export function computeTopologicalWaves(
  tasks: readonly TaskRecord[]
): Array<{ wave: number; task_ids: string[] }> {
  if (tasks.length === 0) {
    return [];
  }

  const taskIds = new Set(tasks.map((t) => t.id));
  const inDegree = new Map<string, number>();
  const dependents = new Map<string, string[]>();
  const seqMap = new Map<string, number>();

  for (const task of tasks) {
    seqMap.set(task.id, task.seq_num);
    let deg = 0;
    for (const dep of task.depends_on) {
      if (!taskIds.has(dep)) continue;
      deg += 1;
      const list = dependents.get(dep);
      if (list) {
        list.push(task.id);
      } else {
        dependents.set(dep, [task.id]);
      }
    }
    inDegree.set(task.id, deg);
  }

  let currentWave: string[] = [];
  for (const [id, deg] of inDegree.entries()) {
    if (deg === 0) {
      currentWave.push(id);
    }
  }

  const waves: Array<{ wave: number; task_ids: string[] }> = [];
  let waveIndex = 0;

  while (currentWave.length > 0) {
    currentWave.sort((a, b) => (seqMap.get(a) ?? 0) - (seqMap.get(b) ?? 0));
    waves.push({ wave: waveIndex, task_ids: currentWave });

    const nextWave: string[] = [];
    for (const completedId of currentWave) {
      for (const childId of dependents.get(completedId) ?? []) {
        const nextDeg = (inDegree.get(childId) ?? 0) - 1;
        inDegree.set(childId, nextDeg);
        if (nextDeg === 0) {
          nextWave.push(childId);
        }
      }
    }
    currentWave = nextWave;
    waveIndex += 1;
  }

  return waves;
}
