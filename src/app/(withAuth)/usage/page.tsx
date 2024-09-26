import type { NextPage } from 'next';

import { Box, Heading, VStack, Image, Text, List, ListItem } from '../../../infrastructures/useClient/chakra';

const CoursesPage: NextPage = async () => {
  return (
    <VStack align="stretch" spacing={6}>
      <Heading as="h1">トレース道場の使い方</Heading>
      <Box>
        <Text fontWeight="bold">■トレース道場の概要</Text>
        <Text>
          トレース道場では、タートルグラフィックスを使ったプログラムのトレース問題を解きます。 問題は「
          <Text as="span" fontWeight="bold">
            一括実行モード
          </Text>
          」と「
          <Text as="span" fontWeight="bold">
            ステップ実行モード
          </Text>
          」の2種類があり、すべての問題は一括実行モードから始まります。
          どちらのモードでも、解答者はタートル（亀）を操作して、プログラムの実行後の盤面を再現する必要があります。
        </Text>
        <Image alt="Usage Overview" my={4} src="/images/usage_01.png" />

        <Text fontWeight="bold">■一括実行モードの解き方</Text>
        <Text>
          まず、出題されたプログラムを読んでタートルの初期位置を考えます。次に、以下の手順で盤面にタートルを配置します。
        </Text>
        <List my={2}>
          <ListItem>① 盤面内でタートルの初期位置となるマスをクリックします。</ListItem>
          <ListItem>② 「タートルを配置」ボタンをクリックして、タートルを配置します。</ListItem>
        </List>
        <Image alt="Initial Setup" my={4} src="/images/usage_02.png" />

        <Text>
          タートルの初期位置が決まったら、プログラムを読み進めながら、「前に進む」「後に戻る」「↰」「↱」などの操作ボタンを使ってタートルを動かし、軌跡を描きます。
        </Text>
        <Image alt="Turtle Movement" my={4} src="/images/usage_03.png" />

        <Text>誤った操作をした場合は、以下の方法で修正できます。</Text>
        <List my={2}>
          <ListItem>・誤った軌跡を描いた場合は、該当するマスを右クリックして白色に戻します。</ListItem>
          <ListItem>
            ・余分なタートルを配置した場合は、タートルを選択して「タートルを削除」ボタンを押して削除します。
          </ListItem>
          <ListItem>・最初からやり直したい場合は、「盤面をリセット」ボタンを押して盤面を初期状態に戻します。</ListItem>
        </List>
        <Text>
          プログラム終了後の状態まで軌跡を描き終えたら、「提出」ボタンをクリックして解答を確認しましょう。
          正解した場合は、指示に従って問題一覧ページに戻り、次の問題に進みます。
          不正解の場合は、やり直します。3回間違えるか、「諦めてステップ実行モードに移行する」ボタンをクリックすると、「ステップ実行モード」に移行します。
        </Text>

        <Text fontWeight="bold" mt={6}>
          ■ステップ実行モードの解き方
        </Text>
        <Text>
          ステップ実行モードでは、一括実行モードとは異なり、プログラムをステップごとに（概ね1行ごとに）変数の値の変化とタートルの軌跡を確認します。
          プログラム上で赤い枠で囲まれた行を実行した後のタートルの位置や軌跡を盤面に描き、「提出」ボタンを押してください。
          正解するまで次のステップに進めないので、正解するまで修正と提出を繰り返します。
        </Text>
        <Text fontWeight="bold">
          タートルの動きがない行が選ばれることもあります。その場合は、盤面を変更せずに「提出」ボタンを押してください。
        </Text>
        <Text>
          ステップ実行モードでは、ステップごとに変数の値とタートルの動きを遡って確認できます。
          画面下部に直前の盤面と変数の一覧が表示されます。「1ステップ前を表示」や「1ステップ後を表示」ボタンを押すと、さらに前の盤面と変数の一覧を表示できます。
          プログラムが終了するまで、ステップ実行モードの問題は続きます。最後まで解き終えたら問題一覧ページに戻り、次の問題に進みましょう。
        </Text>
      </Box>
    </VStack>
  );
};

export default CoursesPage;
