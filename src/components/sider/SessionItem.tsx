import clsx from 'clsx'
import { memo, useRef, useState } from 'react'
import { useTranslate } from '../../i18n/index.js'
import { IconEditOutline16, IconEllipsisOutline16, IconTrashOutline16 } from '../base/icons.js'
import { renameSession, selectSession } from '../../services/chat/store.js'
import type { SessionSummary } from '../../services/chat/types.js'
import { IconButton } from '../base/IconButton.js'
import { Menu } from '../base/Menu.js'
import { closeMobileSider } from './mobileSiderState.js'
import styles from './SessionItem.module.css'

export const SessionItem = memo(function SessionItem({
  session,
  active,
  onDelete,
}: {
  session: SessionSummary
  active: boolean
  onDelete: () => void
}) {
  const t = useTranslate()
  const [editing, setEditing] = useState(false)
  const finishedEditing = useRef(false)
  const displayTitle = session.title || t('untitledChat')

  const finish = (title: string) => {
    if (finishedEditing.current) {
      return
    }
    finishedEditing.current = true
    setEditing(false)
    if (title.trim() && title.trim() !== displayTitle) {
      renameSession(session.id, title.trim())
    }
  }

  return (
    <div
      className={clsx(styles.item, active && styles.active)}
      onClick={() => {
        if (editing) {
          return
        }
        selectSession(session.id)
        closeMobileSider()
      }}
    >
      {editing ? (
        <input
          className={styles.renameInput}
          defaultValue={displayTitle}
          autoFocus
          onFocus={(event) => event.target.select()}
          onBlur={(event) => finish(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && !event.nativeEvent.isComposing) {
              finish(event.currentTarget.value)
            } else if (event.key === 'Escape') {
              finishedEditing.current = true
              setEditing(false)
            }
          }}
        />
      ) : (
        <>
          <div className={styles.title}>{displayTitle}</div>
          <div className={styles.action} onClick={(event) => event.stopPropagation()}>
            <Menu
              options={[
                {
                  key: 'rename',
                  label: t('sessionItemMenuRenameOption'),
                  icon: <IconEditOutline16 />,
                  onSelect: () => {
                    finishedEditing.current = false
                    setEditing(true)
                  },
                },
                {
                  key: 'delete',
                  label: t('delete'),
                  icon: <IconTrashOutline16 />,
                  danger: true,
                  onSelect: onDelete,
                },
              ]}
            >
              {({ toggle }) => (
                <IconButton
                  icon={<IconEllipsisOutline16 />}
                  aria-label={t('more')}
                  onClick={toggle}
                />
              )}
            </Menu>
          </div>
        </>
      )}
    </div>
  )
})
