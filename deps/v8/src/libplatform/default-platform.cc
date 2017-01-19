// Copyright 2013 the V8 project authors. All rights reserved.
// Use of this source code is governed by a BSD-style license that can be
// found in the LICENSE file.

#include "src/libplatform/default-platform.h"

#include <algorithm>
#include <queue>

#include "src/base/logging.h"
#include "src/base/platform/platform.h"
#include "src/base/platform/time.h"
#include "src/base/sys-info.h"
#include "src/libplatform/worker-thread.h"

namespace v8 {
namespace platform {

/**
 * [CreateDefaultPlatform 创建v8平台]
 * @param  thread_pool_size [description]
 * @return                  [description]
 */
v8::Platform* CreateDefaultPlatform(int thread_pool_size) {
  DefaultPlatform* platform = new DefaultPlatform();
  //设置线程池
  platform->SetThreadPoolSize(thread_pool_size);
  //确保平台已经初始化
  platform->EnsureInitialized();
  return platform;
}


bool PumpMessageLoop(v8::Platform* platform, v8::Isolate* isolate) {
  //einterpret_cast运算符是用来处理无关类型之间的转换；它会产生一个新的值，这个值会有与原始参数（expressoin）有完全相同的比特位。
  return reinterpret_cast<DefaultPlatform*>(platform)->PumpMessageLoop(isolate);
}

void SetTracingController(
    v8::Platform* platform,
    v8::platform::tracing::TracingController* tracing_controller) {
  return reinterpret_cast<DefaultPlatform*>(platform)->SetTracingController(
      tracing_controller);
}
//线程池默认 8
const int DefaultPlatform::kMaxThreadPoolSize = 8;

/**
 * 默认thread_pool_size_ = 0
 */
DefaultPlatform::DefaultPlatform()
    : initialized_(false), thread_pool_size_(0), tracing_controller_(NULL) {}
/**
 * 析构函数
 */
DefaultPlatform::~DefaultPlatform() {
  base::LockGuard<base::Mutex> guard(&lock_);
  queue_.Terminate();
  if (initialized_) {
    for (auto i = thread_pool_.begin(); i != thread_pool_.end(); ++i) {
      delete *i;
    }
  }
  for (auto i = main_thread_queue_.begin(); i != main_thread_queue_.end();
       ++i) {
    while (!i->second.empty()) {
      delete i->second.front();
      i->second.pop();
    }
  }
  for (auto i = main_thread_delayed_queue_.begin();
       i != main_thread_delayed_queue_.end(); ++i) {
    while (!i->second.empty()) {
      delete i->second.top().second;
      i->second.pop();
    }
  }

  if (tracing_controller_) {
    tracing_controller_->StopTracing();
    delete tracing_controller_;
  }
}

/**
 * [DefaultPlatform::SetThreadPoolSize 设置线程池大小]
 * @param thread_pool_size [description]
 */
void DefaultPlatform::SetThreadPoolSize(int thread_pool_size) {
  base::LockGuard<base::Mutex> guard(&lock_);
  DCHECK(thread_pool_size >= 0);
  if (thread_pool_size < 1) {
    //获取处理器当前数量然后-1
    thread_pool_size = base::SysInfo::NumberOfProcessors() - 1;
  }
  thread_pool_size_ =
      std::max(std::min(thread_pool_size, kMaxThreadPoolSize), 1);//不能超过最大线程数限制
}

/**
 * [DefaultPlatform::EnsureInitialized 确认平台已经初始化]
 */
void DefaultPlatform::EnsureInitialized() {
  base::LockGuard<base::Mutex> guard(&lock_);//guard：守护的意思
  if (initialized_) return;
  initialized_ = true;
  //添加工作线程到线程池
  //std::vector<WorkerThread*> thread_pool_;
  for (int i = 0; i < thread_pool_size_; ++i)
    thread_pool_.push_back(new WorkerThread(&queue_));
}


Task* DefaultPlatform::PopTaskInMainThreadQueue(v8::Isolate* isolate) {
  //获取主线程任务队列
  auto it = main_thread_queue_.find(isolate);
  //线程队列为空 || 任务队列为空
  if (it == main_thread_queue_.end() || it->second.empty()) {
    return NULL;
  }
  //获取最前面的任务
  Task* task = it->second.front();
  //弹出任务
  it->second.pop();
  //返回要执行的任务
  return task;
}


Task* DefaultPlatform::PopTaskInMainThreadDelayedQueue(v8::Isolate* isolate) {
  //在线程池中找出指定v8实例的优先队列任务
  auto it = main_thread_delayed_queue_.find(isolate);
  //如线程池为空 或者 队列任务为空
  if (it == main_thread_delayed_queue_.end() || it->second.empty()) {
    return NULL;
  }
  //获取时间
  double now = MonotonicallyIncreasingTime();
  //获取最顶部的任务
  std::pair<double, Task*> deadline_and_task = it->second.top();
  if (deadline_and_task.first > now) {
    return NULL;
  }
  //弹出最顶部的任务
  it->second.pop();
  //返回任务
  return deadline_and_task.second;
}

/**
 * [DefaultPlatform::PumpMessageLoop 调度空闲线程从消息队列里处理等待执行事件]
 * @param  isolate [v8实例]
 * @return         [description]
 */
bool DefaultPlatform::PumpMessageLoop(v8::Isolate* isolate) {
  Task* task = NULL;
  {
    //互斥锁（英语：英语：Mutual exclusion，缩写 Mutex）是一种用于多线程编程中，防止两条线程同时对同一公共资源（比如全局变量）进行读写的机制
    base::LockGuard<base::Mutex> guard(&lock_);

    // Move delayed tasks that hit their deadline to the main queue.
    task = PopTaskInMainThreadDelayedQueue(isolate);
    //任务不为空，重复的去问任务有没有完成
    while (task != NULL) {
      //添加到主线程队列
      main_thread_queue_[isolate].push(task);
      //去线程池里面拿个任务
      task = PopTaskInMainThreadDelayedQueue(isolate);
    }

    task = PopTaskInMainThreadQueue(isolate);

    if (task == NULL) {
      return false;
    }
  }
  task->Run();
  delete task;
  return true;
}


void DefaultPlatform::CallOnBackgroundThread(Task *task,
                                             ExpectedRuntime expected_runtime) {
  EnsureInitialized();
  queue_.Append(task);
}


void DefaultPlatform::CallOnForegroundThread(v8::Isolate* isolate, Task* task) {
  base::LockGuard<base::Mutex> guard(&lock_);
  main_thread_queue_[isolate].push(task);
}


void DefaultPlatform::CallDelayedOnForegroundThread(Isolate* isolate,
                                                    Task* task,
                                                    double delay_in_seconds) {
  base::LockGuard<base::Mutex> guard(&lock_);
  double deadline = MonotonicallyIncreasingTime() + delay_in_seconds;
  main_thread_delayed_queue_[isolate].push(std::make_pair(deadline, task));
}


void DefaultPlatform::CallIdleOnForegroundThread(Isolate* isolate,
                                                 IdleTask* task) {
  UNREACHABLE();
}


bool DefaultPlatform::IdleTasksEnabled(Isolate* isolate) { return false; }


double DefaultPlatform::MonotonicallyIncreasingTime() {
  return base::TimeTicks::HighResolutionNow().ToInternalValue() /
         static_cast<double>(base::Time::kMicrosecondsPerSecond);
}


uint64_t DefaultPlatform::AddTraceEvent(
    char phase, const uint8_t* category_enabled_flag, const char* name,
    const char* scope, uint64_t id, uint64_t bind_id, int num_args,
    const char** arg_names, const uint8_t* arg_types,
    const uint64_t* arg_values, unsigned int flags) {
  if (tracing_controller_) {
    return tracing_controller_->AddTraceEvent(
        phase, category_enabled_flag, name, scope, id, bind_id, num_args,
        arg_names, arg_types, arg_values, flags);
  }

  return 0;
}

void DefaultPlatform::UpdateTraceEventDuration(
    const uint8_t* category_enabled_flag, const char* name, uint64_t handle) {
  if (tracing_controller_) {
    tracing_controller_->UpdateTraceEventDuration(category_enabled_flag, name,
                                                  handle);
  }
}

const uint8_t* DefaultPlatform::GetCategoryGroupEnabled(const char* name) {
  if (tracing_controller_) {
    return tracing_controller_->GetCategoryGroupEnabled(name);
  }
  static uint8_t no = 0;
  return &no;
}


const char* DefaultPlatform::GetCategoryGroupName(
    const uint8_t* category_enabled_flag) {
  static const char dummy[] = "dummy";
  return dummy;
}

void DefaultPlatform::SetTracingController(
    tracing::TracingController* tracing_controller) {
  tracing_controller_ = tracing_controller;
}

size_t DefaultPlatform::NumberOfAvailableBackgroundThreads() {
  return static_cast<size_t>(thread_pool_size_);
}

}  // namespace platform
}  // namespace v8
