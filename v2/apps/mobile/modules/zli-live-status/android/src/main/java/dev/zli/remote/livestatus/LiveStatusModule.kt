package dev.zli.remote.livestatus

import android.content.Context
import expo.modules.kotlin.exception.Exceptions
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import expo.modules.kotlin.records.Field
import expo.modules.kotlin.records.Record

private const val ON_ACTION = "onAction"

class LiveStatusAction : Record {
  @Field var target: String = ""
  @Field var label: String = ""
  @Field var kind: String = ""
}

class LiveStatusContent : Record {
  @Field var title: String = ""
  @Field var detail: String = ""
  @Field var badge: String = ""
  @Field var others: String? = null
  @Field var needsYou: Boolean = false
  @Field var url: String = ""
  @Field var actions: List<LiveStatusAction> = emptyList()
}

class LiveStatusModule : Module() {
  private val context: Context
    get() = appContext.reactContext ?: throw Exceptions.ReactContextLost()

  override fun definition() = ModuleDefinition {
    Name("ZliLiveStatus")
    Events(ON_ACTION)

    OnStartObserving {
      LiveStatusPresses.listen { target -> sendEvent(ON_ACTION, mapOf("target" to target)) }
    }

    OnStopObserving {
      LiveStatusPresses.listen(null)
    }

    AsyncFunction("show") { content: LiveStatusContent ->
      LiveStatusService.show(context, LiveStatusNotification.build(context, content))
    }

    AsyncFunction("hide") {
      LiveStatusService.hide(context)
    }
  }
}

/** Hands button presses from the notification to JavaScript, which sends them to the desktop. */
internal object LiveStatusPresses {
  private var listener: ((String) -> Unit)? = null

  @Synchronized
  fun listen(next: ((String) -> Unit)?) {
    listener = next
  }

  @Synchronized
  fun press(target: String) {
    listener?.invoke(target)
  }
}
